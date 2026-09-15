import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from review_scope import decision, select_scope, verify_scope, failure_context, main

OLD, BASE, HEAD, MERGE = (letter * 40 for letter in "abcd")
CELLS = "codex/L2 codex/L3 codex/L4 codex/L5 kiro-opus/L2 kiro-opus/L3 kiro-opus/L4 kiro-opus/L5 kiro-gpt/L2 kiro-gpt/L3 kiro-gpt/L4 kiro-gpt/L5"


class ReviewScopeTests(unittest.TestCase):
    def setUp(self):
        self.env = dict(GITHUB_REPOSITORY="owner/repo", PR_NUMBER="300", GITHUB_REF="refs/heads/main", GITHUB_EVENT_NAME="pull_request_target")
        self.event = dict(number=300, pull_request=dict(head=dict(sha=HEAD), base=dict(sha=OLD)))
        self.pr = dict(number=300, title="title\nresult=pass", state="open", merged=False,
                       base=dict(ref="main", repo=dict(full_name="owner/repo")),
                       head=dict(sha=HEAD, repo=dict(full_name="owner/repo")), merge_commit_sha=MERGE)
        self.responses = {
            "repos/owner/repo/pulls/300": self.pr,
            "repos/owner/repo/git/ref/heads/main": dict(ref="refs/heads/main", object=dict(type="commit", sha=BASE)),
            f"repos/owner/repo/compare/{BASE}...{HEAD}": dict(base_commit=dict(sha=BASE), merge_base_commit=dict(sha=BASE)),
            f"repos/owner/repo/commits/{MERGE}": dict(sha=MERGE, parents=[dict(sha=BASE), dict(sha=HEAD)], commit=dict(tree=dict(sha="e"*40))),
            f"repos/owner/repo/commits/{HEAD}": dict(sha=HEAD, commit=dict(tree=dict(sha="e"*40))),
        }
        self.api = self.responses.__getitem__

    def test_stale_event_base_uses_current_authenticated_ref_for_context_and_diff(self):
        scope = select_scope(self.env, self.event, self.api)
        self.assertEqual((scope["base"], scope["diff_base"], scope["head"]), (BASE, BASE, HEAD))

    def test_open_diff_uses_merge_base_of_the_selected_current_ref(self):
        self.responses[f"repos/owner/repo/compare/{BASE}...{HEAD}"]["merge_base_commit"]["sha"] = OLD
        scope = select_scope(self.env, self.event, self.api)
        self.assertEqual((scope["base"], scope["diff_base"]), (BASE, OLD))

    def test_stale_event_head_and_forks_are_rejected(self):
        for field in ("sha", "repo"):
            with self.subTest(field=field):
                original = copy.deepcopy(self.pr["head"])
                self.pr["head"][field] = OLD if field == "sha" else dict(full_name="fork/repo")
                with self.assertRaises(ValueError):
                    select_scope(self.env, self.event, self.api)
                self.pr["head"] = original

    def test_base_advance_before_publication_rejects_the_saved_scope(self):
        saved = select_scope(self.env, self.event, self.api)
        self.responses["repos/owner/repo/git/ref/heads/main"]["object"]["sha"] = OLD
        self.responses[f"repos/owner/repo/compare/{OLD}...{HEAD}"] = dict(base_commit=dict(sha=OLD), merge_base_commit=dict(sha=OLD))
        with self.assertRaisesRegex(ValueError, "stale"):
            verify_scope(saved, self.env, self.event, self.api)
        self.assertTrue(failure_context(saved, self.env, self.api))

    def test_failure_reporting_does_not_replace_a_new_head_review(self):
        saved = select_scope(self.env, self.event, self.api)
        self.pr["head"]["sha"] = OLD
        self.assertFalse(failure_context(saved, self.env, self.api))
        self.pr["base"]["repo"]["full_name"] = "other/repo"
        with self.assertRaises(ValueError):
            failure_context(saved, self.env, self.api)

    def merged(self):
        self.env["GITHUB_EVENT_NAME"] = "workflow_dispatch"
        self.pr.update(state="closed", merged=True)

    def test_merged_review_uses_first_parent_not_current_main_or_event_base(self):
        self.merged()
        self.responses.pop("repos/owner/repo/git/ref/heads/main")
        scope = select_scope(self.env, self.event, self.api)
        self.assertEqual((scope["base"], scope["diff_base"], scope["head"], scope["merge"]), (BASE, BASE, HEAD, MERGE))

    def test_merged_dispatch_rejects_wrong_ref_target_unmerged_or_parentage(self):
        for defect in ("ref", "target", "unmerged", "squash", "octopus", "wrong_head"):
            with self.subTest(defect=defect):
                self.setUp(); self.merged()
                commit = self.responses[f"repos/owner/repo/commits/{MERGE}"]
                if defect == "ref": self.env["GITHUB_REF"] = "refs/heads/feature"
                if defect == "target": self.pr["base"]["ref"] = "dev"
                if defect == "unmerged": self.pr["merged"] = False
                if defect == "squash": commit["parents"].pop()
                if defect == "octopus": commit["parents"].append(dict(sha=OLD))
                if defect == "wrong_head": commit["parents"][1]["sha"] = OLD
                with self.assertRaises(ValueError):
                    select_scope(self.env, self.event, self.api)

    def test_live_head_change_cannot_publish_a_merged_review(self):
        self.merged()
        saved = select_scope(self.env, self.event, self.api)
        self.pr["head"]["sha"] = OLD
        with self.assertRaises(ValueError):
            verify_scope(saved, self.env, self.event, self.api)

    def test_merged_tree_must_equal_head_tree_to_avoid_reversing_base_changes(self):
        self.merged()
        self.responses[f"repos/owner/repo/commits/{HEAD}"]["commit"]["tree"]["sha"] = OLD
        with self.assertRaisesRegex(ValueError, "Merged tree differs"):
            select_scope(self.env, self.event, self.api)

    def test_cli_control_survives_historical_checkout_and_exports_no_title(self):
        self.merged()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            historical = root / "historical-base"
            historical.mkdir()  # No helper exists in this old checkout.
            control = root / "trusted-control.py"
            shutil.copyfile(Path(__file__).with_name("review_scope.py"), control)
            shutil.copyfile(Path(__file__).with_name("review_format.py"), root / "review_format.py")
            (root / "responses.json").write_text(json.dumps(self.responses))
            (root / "event.json").write_text(json.dumps(self.event))
            (root / "gh").write_text(
                f"#!{sys.executable}\nimport json,os,sys\n"
                "print(json.dumps(json.load(open(os.environ['FIXTURES']))[sys.argv[2]]))\n"
            )
            (root / "gh").chmod(0o700)
            env = {**os.environ, **self.env, "PATH": f"{root}:{os.environ['PATH']}",
                   "GH_TOKEN": "fixture-token", "FIXTURES": str(root / "responses.json"),
                   "GITHUB_EVENT_PATH": str(root / "event.json"),
                   "GITHUB_OUTPUT": str(root / "outputs"),
                   "REVIEW_SCOPE_FILE": str(root / "scope.json")}
            result = subprocess.run([sys.executable, str(control), "select"], cwd=historical,
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "outputs").read_text(),
                             f"base={BASE}\nhead={HEAD}\ndiff_base={BASE}\nnumber=300\n")
            self.assertEqual(json.loads((root / "scope.json").read_text())["title"], "title\nresult=pass")

    def test_pass_requires_complete_diff_all_cells_and_one_terminal_verdict(self):
        full = b"+line\n" * 3000
        self.assertEqual(decision("review\nCOVERAGE: COMPLETE\nVERDICT: PASS\n", full, full, CELLS)[0], "pass")
        cases = [
            dict(full=full+b"+extra\n"), dict(panel=full[:-1]), dict(partial=True),
            dict(omitted=True), dict(failed=True), dict(responded=" ".join(CELLS.split()[:-1])),
            dict(responded=CELLS+" codex/L2"), dict(responded=""),
            dict(review="COVERAGE: COMPLETE\nVERDICT: PASS\nVERDICT: FAIL\n"),
            dict(review="COVERAGE: COMPLETE\nVERDICT: PASS\nmore"),
            dict(review="12 transcripts received\nVERDICT: PASS\n"),
            dict(review="Kiro/L4 unfinished\nCOVERAGE: INCOMPLETE\nVERDICT: PASS\n"),
            dict(review="COVERAGE: COMPLETE\nCOVERAGE: INCOMPLETE\nVERDICT: PASS\n"),
        ]
        for changed in cases:
            with self.subTest(changed=list(changed)):
                args = dict(review="COVERAGE: COMPLETE\nVERDICT: PASS\n", full=full, panel=full, responded=CELLS)
                args.update(changed)
                self.assertEqual(decision(**args)[0], "fail")

    def test_current_specialist_mode_accepts_all_three_required_reports(self):
        reports = "codex/L2 kiro-opus/L3 kiro-gpt/L4"
        with patch.dict(os.environ, {"ROLE_REVIEW": "1"}):
            result, reason = decision(
                "COVERAGE: COMPLETE\nVERDICT: PASS\n", b"+line\n", b"+line\n", reports
            )
        self.assertEqual(result, "pass", reason)

    def test_workflow_control_bundle_survives_a_historical_checkout_in_role_mode(self):
        source = Path(__file__).resolve().parent
        workflow = source.parents[1] / ".github/workflows/pr-review.yml"
        marker = "      - name: Resolve and pin the review scope\n"
        self.assertIn(marker, workflow.read_text())
        step = workflow.read_text().split(marker, 1)[1].split("\n      - name:", 1)[0]
        body = textwrap.dedent(step.split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout, control_parent, binary = root / "checkout", root / "runner", root / "bin"
            checkout.mkdir()
            control_parent.mkdir()
            binary.mkdir()
            shutil.copytree(source, checkout / "scripts/pr-review", ignore=shutil.ignore_patterns("__pycache__"))
            subprocess.run(["git", "init", "-q"], cwd=checkout, check=True)
            subprocess.run(["git", "add", "scripts/pr-review"], cwd=checkout, check=True)
            subprocess.run(
                ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "Trusted control fixture"],
                cwd=checkout, check=True,
            )
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip()
            (root / "responses.json").write_text(json.dumps(self.responses))
            (root / "event.json").write_text(json.dumps(self.event))
            (binary / "gh").write_text(
                f"#!{sys.executable}\nimport json,os,sys\n"
                "print(json.dumps(json.load(open(os.environ['FIXTURES']))[sys.argv[2]]))\n"
            )
            (binary / "gh").chmod(0o700)
            env = {
                **os.environ, **self.env, "ROLE_REVIEW": "1",
                "PATH": f"{binary}:{os.environ['PATH']}", "GH_TOKEN": "fixture-token",
                "FIXTURES": str(root / "responses.json"), "RUNNER_TEMP": str(control_parent),
                "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_ENV": str(root / "environment"),
                "GITHUB_OUTPUT": str(root / "outputs"),
                "GITHUB_EVENT_PATH": str(root / "event.json"),
                "GITHUB_WORKFLOW_SHA": revision,
            }
            fixture_body = body.replace("${{ github.workflow_sha }}", revision)
            fixture_body = fixture_body.replace("/tmp/review", str(root / "review"))
            result = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", fixture_body],
                cwd=checkout, env=env, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            exported = dict(line.split("=", 1) for line in (root / "environment").read_text().splitlines())
            control = Path(exported["REVIEW_CONTROL"])
            for name in ("review_scope.py", "review_format.py", "report_frame.py", "codex_events.py", "specialist_roles.py",
                         "kiro-safety.sh", "preflight-aws-session.py", "agents/pr-review-readonly.json"):
                self.assertTrue((control / name).is_file(), name)
                self.assertFalse((control / name).stat().st_mode & 0o222, name)
            historical = root / "historical"
            historical.mkdir()
            result = subprocess.run(
                [sys.executable, exported["REVIEW_HELPER"], "select"],
                cwd=historical, env={**env, **exported}, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            saved = json.loads(Path(exported["REVIEW_SCOPE_FILE"]).read_text())
            self.assertEqual(saved["required_cells"], ["codex/L2", "kiro-gpt/L4", "kiro-opus/L3"])

    def test_specialist_mode_still_rejects_a_missing_required_role(self):
        with patch.dict(os.environ, {"ROLE_REVIEW": "1"}):
            result, _ = decision(
                "COVERAGE: COMPLETE\nVERDICT: PASS\n", b"+line\n", b"+line\n",
                "codex/L2 kiro-opus/L3",
            )
        self.assertEqual(result, "fail")


    def report_fixture(self, directory):
        root = Path(directory)
        work = root / "pr-review"
        reports = work / "full-reports.fixture"
        reports.mkdir(parents=True, mode=0o700)
        work.chmod(0o700)
        records = []
        for cell in CELLS.split():
            path = reports / (cell.replace("/", "-") + ".md")
            data = b"tool transcript\n" * 2000 + b"Final findings: no blocking issues.\n"
            path.write_bytes(data)
            path.chmod(0o400)
            records.append(dict(cell=cell, path=str(path), size=len(data),
                                sha256=hashlib.sha256(data).hexdigest()))
        manifest = work / "full-reports.json"
        manifest.write_text(json.dumps(dict(reports=records)))
        manifest.chmod(0o400)
        (work / "synth-prompt.txt").write_text(
            f"TRUSTED_FULL_REPORT_DIR: {reports}\n"
            f"TRUSTED_FULL_REPORTS_JSON: {manifest.read_text()}\n"
        )
        (work / "synth-stdin.txt").write_text(
            "\n".join("FULL_REPORT: " + json.dumps(record) for record in records)
            + "\n[PREVIEW CAPPED; Read full reports]\n"
        )
        (work / "responded.txt").write_text(CELLS)
        full = b"+line\n"
        (root / "pr-diff.txt").write_bytes(full)
        (root / "pr-diff-truncated.txt").write_bytes(full)
        (root / "review.md").write_text("COVERAGE: COMPLETE\nVERDICT: PASS\n")
        (root / "event.json").write_text(json.dumps(self.event))
        scope = select_scope(self.env, self.event, self.api)
        scope.update(diff_sha256=hashlib.sha256(full).hexdigest(), lines=1)
        (root / "scope.json").write_text(json.dumps(scope))
        mapped = {str(Path("/tmp") / name): root / name for name in (
            "pr-review", "pr-review/responded.txt", "pr-review/coverage-severe.flag",
            "pr-diff.txt", "pr-diff-truncated.txt", "review.md",
            "pr-diff-omitted.txt", "pr-diff-omitted-source.txt",
        )}

        def invoke(command, *, phases="true"):
            env = dict(self.env, REVIEW_SCOPE_FILE=str(root / "scope.json"),
                       GITHUB_EVENT_PATH=str(root / "event.json"),
                       GITHUB_OUTPUT=str(root / "outputs"), GATE_RESULT="pass")
            if phases is not None:
                env["REVIEW_PHASES_SUCCEEDED"] = phases
            with patch.dict(os.environ, env, clear=True), \
                    patch.object(sys, "argv", ["review_scope.py", command]), \
                    patch("review_scope.api", self.api), \
                    patch("review_scope.Path", side_effect=lambda value: mapped.get(str(value), Path(value))):
                main()
        return root, work, records, invoke

    def test_gate_binds_full_reports_and_verify_rechecks_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, records, invoke = self.report_fixture(directory)
            invoke("gate")
            self.assertIn("result=pass\n", (root / "outputs").read_text())
            saved = json.loads((root / "scope.json").read_text())
            self.assertEqual(saved.get("full_reports", {}).get("manifest_sha256"),
                             hashlib.sha256((work / "full-reports.json").read_bytes()).hexdigest())
            invoke("verify")
            path = Path(records[0]["path"])
            data = path.read_bytes().replace(b"Final findings", b"Other findings")
            path.chmod(0o600)
            path.write_bytes(data)  # Same length and permissions: the hash must detect this.
            path.chmod(0o400)
            with self.assertRaisesRegex(ValueError, "report|completeness"):
                invoke("verify")

    def test_failed_or_unknown_review_phase_cannot_pass_with_complete_looking_files(self):
        for phases in ("false", "", None):
            with self.subTest(phases=phases), tempfile.TemporaryDirectory() as directory:
                root, _, _, invoke = self.report_fixture(directory)
                invoke("gate", phases=phases)
                self.assertIn("result=fail\n", (root / "outputs").read_text())

    def test_publication_rechecks_the_successful_phase_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, _, invoke = self.report_fixture(directory)
            invoke("gate")
            saved = json.loads((root / "scope.json").read_text())
            self.assertIs(saved.get("review_phases_succeeded"), True)
            saved["review_phases_succeeded"] = False
            (root / "scope.json").write_text(json.dumps(saved))
            with self.assertRaisesRegex(ValueError, "completeness"):
                invoke("verify")

    def test_gate_rejects_missing_changed_or_incomplete_full_report_records(self):
        for defect in ("missing_manifest", "missing_file", "changed_file", "changed_size",
                       "duplicate_cell", "missing_cell", "symlink", "missing_marker"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                root, work, records, invoke = self.report_fixture(directory)
                manifest = work / "full-reports.json"
                path = Path(records[0]["path"])
                if defect == "missing_manifest":
                    manifest.unlink()
                elif defect == "missing_file":
                    path.unlink()
                elif defect == "changed_file":
                    data = path.read_bytes().replace(b"Final findings", b"Other findings")
                    path.chmod(0o600)
                    path.write_bytes(data)
                    path.chmod(0o400)
                elif defect == "symlink":
                    path.unlink()
                    path.symlink_to(records[1]["path"])
                elif defect == "missing_marker":
                    (work / "synth-stdin.txt").write_text("preview with no full-report locations")
                else:
                    if defect == "changed_size": records[0]["size"] += 1
                    if defect == "duplicate_cell": records[-1] = records[0]
                    if defect == "missing_cell": records.pop()
                    manifest.chmod(0o600)
                    manifest.write_text(json.dumps(dict(reports=records)))
                    manifest.chmod(0o400)
                invoke("gate")
                self.assertIn("result=fail\n", (root / "outputs").read_text())

    def test_gate_rejects_missing_forged_or_duplicate_report_read_authority(self):
        for defect in ("missing_prompt", "wrong_directory", "forged_record", "duplicate_authority"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                root, work, records, invoke = self.report_fixture(directory)
                prompt = work / "synth-prompt.txt"
                if defect == "missing_prompt":
                    prompt.unlink()
                elif defect == "wrong_directory":
                    prompt.write_text(prompt.read_text().replace(
                        str(work / "full-reports.fixture"), str(root / "outside"), 1))
                elif defect == "forged_record":
                    forged = copy.deepcopy(records)
                    forged[0]["path"] = str(root / "outside-report.md")
                    prompt.write_text(
                        f"TRUSTED_FULL_REPORT_DIR: {work / 'full-reports.fixture'}\n"
                        f"TRUSTED_FULL_REPORTS_JSON: {json.dumps(dict(reports=forged))}\n")
                else:
                    prompt.write_text(prompt.read_text() + 'TRUSTED_FULL_REPORTS_JSON: {"reports":[]}\n')
                invoke("gate")
                self.assertIn("result=fail\n", (root / "outputs").read_text())

    def test_publication_rejects_prompt_changes_after_the_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            _, work, _, invoke = self.report_fixture(directory)
            invoke("gate")
            prompt = work / "synth-prompt.txt"
            prompt.write_text(prompt.read_text() + "Different review instructions.\n")
            with self.assertRaisesRegex(ValueError, "report|completeness|input"):
                invoke("verify")

    def test_deleted_full_records_after_gate_cannot_pass_verify(self):
        for missing in ("report", "manifest"):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                _, work, records, invoke = self.report_fixture(directory)
                invoke("gate")
                (Path(records[0]["path"]) if missing == "report" else work / "full-reports.json").unlink()
                with self.assertRaisesRegex(ValueError, "completeness"):
                    invoke("verify")

    def test_replacing_manifest_and_full_reports_after_gate_cannot_pass_verify(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, records, invoke = self.report_fixture(directory)
            invoke("gate")
            path = Path(records[0]["path"])
            path.chmod(0o600)
            data = b"replacement report: no findings\n"
            path.write_bytes(data)
            path.chmod(0o400)
            records[0].update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
            manifest = work / "full-reports.json"
            manifest.chmod(0o600)
            manifest.write_text(json.dumps(dict(reports=records)))
            manifest.chmod(0o400)
            (work / "synth-stdin.txt").write_text(
                "\n".join("FULL_REPORT: " + json.dumps(record) for record in records) + "\n")
            (work / "synth-prompt.txt").write_text(
                f"TRUSTED_FULL_REPORT_DIR: {work / 'full-reports.fixture'}\n"
                f"TRUSTED_FULL_REPORTS_JSON: {manifest.read_text()}\n")
            with self.assertRaisesRegex(ValueError, "report|completeness"):
                invoke("verify")

    def test_retained_capped_reports_do_not_exempt_incomplete_semantic_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, _, invoke = self.report_fixture(directory)
            (root / "review.md").write_text("kiro-opus/L2 unfinished\nCOVERAGE: INCOMPLETE\nVERDICT: PASS\n")
            invoke("gate")
            self.assertIn("result=fail\nreason=Semantic cell coverage", (root / "outputs").read_text())


if __name__ == "__main__":
    unittest.main()
