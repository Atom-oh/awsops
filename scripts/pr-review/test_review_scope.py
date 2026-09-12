import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from review_scope import decision, select_scope, verify_scope, failure_context

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


if __name__ == "__main__":
    unittest.main()
