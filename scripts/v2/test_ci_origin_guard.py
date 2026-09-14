import copy
import importlib.util
import pathlib
import unittest


PATH = pathlib.Path(__file__).with_name("ci_origin_guard.py")
SPEC = importlib.util.spec_from_file_location("ci_origin_guard", PATH)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)

MERGE = "a" * 40
HEAD = "b" * 40
BASE = "c" * 40
TREE = "d" * 40
REPO = "Atom-oh/awsops"
CELLS = "codex/L2 kiro-opus/L3 kiro-gpt/L4"


class ReleaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "GITHUB_REPOSITORY": REPO,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_SHA": MERGE,
        }
        self.pr = {
            "number": 400, "state": "closed", "merged_at": "2026-09-14T00:00:00Z",
            "merge_commit_sha": MERGE,
            "base": {"ref": "main", "repo": {"full_name": REPO}},
            "head": {"sha": HEAD, "repo": {"full_name": REPO}},
        }
        self.comment = {
            "id": 1, "user": {"login": "github-actions[bot]"}, "updated_at": "2026-09-14T00:00:00Z",
            "body": f"<!-- multi-ai-pr-review -->\n_Cells (model/lens): {CELLS} _\n"
                    f"**Status: PASSED** — No blocking issues found\n\nCOVERAGE: COMPLETE\n\n"
                    f"_Triggered by commit `{HEAD}` · workflow: `.github/workflows/pr-review.yml`_\n",
        }
        self.checks = [
            {"id": i, "name": name, "head_sha": HEAD, "status": "completed", "conclusion": "success",
             "app": {"slug": "github-actions"},
             "details_url": f"https://github.com/{REPO}/actions/runs/{200 + i}/job/{i}"}
            for i, name in enumerate(("AI Code Review", "Merge Verify", "Deck Verify (docs-site pptx gates)"), 1)
        ]
        self.reviews = []
        self.inline = []
        self.threads = []
        self.runs = {
            201: {"path": ".github/workflows/pr-review.yml", "event": "pull_request_target",
                  "head_sha": HEAD, "status": "completed", "conclusion": "success"},
            202: {"path": ".github/workflows/merge-verify.yml", "event": "pull_request",
                  "head_sha": HEAD, "status": "completed", "conclusion": "success"},
            203: {"path": ".github/workflows/merge-verify.yml", "event": "pull_request",
                  "head_sha": HEAD, "status": "completed", "conclusion": "success"},
        }
        self.ref_reads = 0
        self.move_main = False
        self.git_reads = []
        self.merge_commit = {
            "sha": MERGE, "parents": [{"sha": BASE}, {"sha": HEAD}], "tree": {"sha": TREE},
        }
        self.head_commit = {"sha": HEAD, "parents": [{"sha": BASE}], "tree": {"sha": TREE}}

    def fetch(self, path):
        if path == f"repos/{REPO}/git/commits/{MERGE}":
            self.git_reads.append(path)
            return copy.deepcopy(self.merge_commit)
        if path == f"repos/{REPO}/git/commits/{HEAD}":
            self.git_reads.append(path)
            return copy.deepcopy(self.head_commit)
        if path.endswith("/git/ref/heads/main"):
            self.ref_reads += 1
            sha = "c" * 40 if self.move_main and self.ref_reads > 1 else MERGE
            return {"object": {"sha": sha}}
        if "/commits/" in path and "/pulls?" in path:
            return [copy.deepcopy(self.pr)]
        if path.endswith("/pulls/400"):
            return copy.deepcopy(self.pr)
        if "/check-runs?" in path:
            return {"check_runs": copy.deepcopy(self.checks)}
        if "/actions/runs/" in path:
            return copy.deepcopy(self.runs[int(path.rsplit("/", 1)[1])])
        if "/issues/400/comments?" in path:
            return [copy.deepcopy(self.comment)]
        if "/pulls/400/reviews?" in path:
            return copy.deepcopy(self.reviews)
        if "/pulls/400/comments?" in path:
            return copy.deepcopy(self.inline)
        if path == "review-threads/400":
            return {"data": {"repository": {"pullRequest": {
                "headRefOid": HEAD, "reviewThreads": {
                    "pageInfo": {"hasNextPage": False}, "nodes": copy.deepcopy(self.threads)
                }
            }}}}
        raise AssertionError("unexpected endpoint: " + path)

    def test_reviewed_merged_commit_passes(self):
        result = guard.verify_release(self.env, self.fetch)
        self.assertEqual(result["commit_sha"], MERGE)
        self.assertEqual(result["reviewed_head"], HEAD)
        self.assertEqual(result["pr_number"], 400)
        self.assertEqual(self.ref_reads, 2)
        self.assertEqual(self.git_reads, [
            f"repos/{REPO}/git/commits/{MERGE}", f"repos/{REPO}/git/commits/{HEAD}",
        ])

    def test_merge_requires_exactly_two_parents_including_reviewed_second_parent(self):
        for parents in (
            [], [{"sha": BASE}],  # Root/squash/rebase commits cannot inherit PR HEAD review.
            [{"sha": BASE}, {"sha": HEAD}, {"sha": "e" * 40}],
            [{"sha": HEAD}, {"sha": BASE}],  # Reviewed HEAD as first parent is insufficient.
            [{"sha": BASE}, {"sha": "e" * 40}],
        ):
            with self.subTest(parents=parents):
                self.merge_commit["parents"] = parents
                with self.assertRaises(guard.GuardError):
                    guard.verify_release(self.env, self.fetch)

    def test_merge_tree_must_equal_reviewed_head_tree(self):
        self.merge_commit["tree"]["sha"] = "e" * 40
        with self.assertRaisesRegex(guard.GuardError, "^merge_tree_mismatch$"):
            guard.verify_release(self.env, self.fetch)

    def test_git_commit_responses_must_bind_to_requested_shas_and_valid_trees(self):
        cases = [
            ("merge_commit", "sha", "e" * 40),
            ("head_commit", "sha", "e" * 40),
            ("merge_commit", "tree", None),
            ("head_commit", "tree", {}),
            ("head_commit", "tree", {"sha": "not-a-tree"}),
            ("merge_commit", "parents", [{"sha": ""}, {"sha": HEAD}]),
        ]
        for attribute, field, value in cases:
            original = copy.deepcopy(getattr(self, attribute))
            with self.subTest(attribute=attribute, field=field, value=value):
                getattr(self, attribute)[field] = value
                with self.assertRaises(guard.GuardError):
                    guard.verify_release(self.env, self.fetch)
            setattr(self, attribute, original)

    def test_missing_tree_hashes_cannot_pass_by_equal_absence(self):
        self.merge_commit["tree"] = {}
        self.head_commit["tree"] = {}
        with self.assertRaises(guard.GuardError):
            guard.verify_release(self.env, self.fetch)

    def test_only_origin_main_manual_dispatch_is_allowed(self):
        for key, value in [
            ("GITHUB_REPOSITORY", "someone/awsops"),
            ("GITHUB_REF", "refs/heads/dev"),
            ("GITHUB_EVENT_NAME", "pull_request"),
            ("GITHUB_SERVER_URL", "https://untrusted.example.test"),
            ("GITHUB_SHA", "main; echo unsafe"),
        ]:
            with self.subTest(key=key):
                env = {**self.env, key: value}
                with self.assertRaises(guard.GuardError):
                    guard.verify_release(env, self.fetch)

    def test_nonmerged_or_wrong_target_source_is_rejected(self):
        for changes in [
            {"state": "open"}, {"merged_at": None}, {"merge_commit_sha": "d" * 40},
            {"base": {"ref": "dev", "repo": {"full_name": REPO}}},
            {"head": {"sha": HEAD, "repo": {"full_name": "fork/awsops"}}},
        ]:
            with self.subTest(changes=changes):
                original = self.pr
                self.pr = {**original, **changes}
                with self.assertRaises(guard.GuardError):
                    guard.verify_release(self.env, self.fetch)
                self.pr = original

    def test_stale_review_and_missing_required_cells_are_rejected(self):
        original = self.comment["body"]
        for body in [
            original.replace(HEAD, "e" * 40),
            original.replace("kiro-gpt/L4", ""),
            original.replace("PASSED", "BLOCKED"),
            original.replace("COVERAGE: COMPLETE", "COVERAGE: INCOMPLETE"),
            original + "\n_⚠️ diff truncated to first 3000 lines — review is partial._",
        ]:
            with self.subTest(body=body[:60]):
                self.comment["body"] = body
                with self.assertRaises(guard.GuardError):
                    guard.verify_release(self.env, self.fetch)

    def test_copied_marker_or_fenced_pass_is_not_a_review(self):
        self.comment["user"]["login"] = "contributor"
        with self.assertRaises(guard.GuardError):
            guard.verify_release(self.env, self.fetch)
        self.comment["user"]["login"] = "github-actions[bot]"
        self.comment["body"] = "```\n" + self.comment["body"] + "\n```\n"
        with self.assertRaises(guard.GuardError):
            guard.verify_release(self.env, self.fetch)

    def test_missing_failed_pending_or_wrong_head_checks_block_release(self):
        original = copy.deepcopy(self.checks)
        for checks in [
            original[1:],
            [{**original[0], "conclusion": "failure"}, *original[1:]],
            [{**original[0], "status": "in_progress", "conclusion": None}, *original[1:]],
            [{**original[0], "head_sha": "e" * 40}, *original[1:]],
            [{**original[0], "app": {"slug": "another-app"}}, *original[1:]],
        ]:
            with self.subTest(checks=checks):
                self.checks = checks
                with self.assertRaises(guard.GuardError):
                    guard.verify_release(self.env, self.fetch)

    def test_branch_movement_during_verification_blocks_release(self):
        self.move_main = True
        with self.assertRaises(guard.GuardError):
            guard.verify_release(self.env, self.fetch)

    def test_successful_check_name_cannot_impersonate_the_required_workflow(self):
        self.runs[201]["path"] = ".github/workflows/untrusted.yml"
        with self.assertRaises(guard.GuardError):
            guard.verify_release(self.env, self.fetch)

    def test_active_change_request_blocks_and_dismissal_does_not(self):
        self.reviews = [{"id": 1, "user": {"login": "reviewer"}, "state": "CHANGES_REQUESTED"}]
        with self.assertRaises(guard.GuardError):
            guard.verify_release(self.env, self.fetch)
        self.reviews[0]["state"] = "DISMISSED"
        self.assertEqual(guard.verify_release(self.env, self.fetch)["commit_sha"], MERGE)

    def test_a_later_comment_does_not_clear_a_change_request(self):
        self.reviews = [
            {"id": 1, "user": {"login": "reviewer"}, "state": "CHANGES_REQUESTED"},
            {"id": 2, "user": {"login": "reviewer"}, "state": "COMMENTED"},
        ]
        with self.assertRaises(guard.GuardError):
            guard.verify_release(self.env, self.fetch)

    def test_heading_numbered_and_emphasized_blocking_threads_are_rejected(self):
        self.inline = [{"id": 1}]
        self.threads = [{
            "isResolved": False, "isOutdated": False,
            "comments": {"pageInfo": {"hasNextPage": False}, "nodes": [{"body": ""}]},
        }]
        for text in ["### MAJOR issue", "1. **CRITICAL** issue", "- [P1] issue",
                     "**Severity:** Major", "## 🔴 CRITICAL issue"]:
            with self.subTest(text=text):
                self.threads[0]["comments"]["nodes"][0]["body"] = text
                with self.assertRaises(guard.GuardError):
                    guard.verify_release(self.env, self.fetch)
        self.threads[0]["isResolved"] = True
        self.assertEqual(guard.verify_release(self.env, self.fetch)["commit_sha"], MERGE)

    def test_outdated_unresolved_major_blocks_until_explicitly_resolved(self):
        self.inline = [{"id": 1}]
        self.threads = [{
            "isResolved": False, "isOutdated": True,
            "comments": {"pageInfo": {"hasNextPage": False}, "nodes": [{"body": "MAJOR: still unresolved"}]},
        }]
        with self.assertRaisesRegex(guard.GuardError, "^unresolved_blocking_thread$"):
            guard.verify_release(self.env, self.fetch)
        self.threads[0]["isResolved"] = True
        self.assertEqual(guard.verify_release(self.env, self.fetch)["commit_sha"], MERGE)

    def test_first_visible_finding_severity_blocks_current_and_outdated_threads(self):
        self.inline = [{"id": 1}]
        self.threads = [{
            "isResolved": False, "isOutdated": False,
            "comments": {"pageInfo": {"hasNextPage": False}, "nodes": [{"body": ""}]},
        }]
        for outdated in (False, True):
            self.threads[0]["isOutdated"] = outdated
            for body in (
                "Finding1(MAJOR): unresolved risk",
                "Finding 1 (MAJOR): unresolved risk",
                "### **Finding 2 (Critical)** — release issue",
                "\n\nFinding #3 [P1]: release issue",
                "> Quoted context\n\n```\nexample\n```\nFinding 1 (Major): actual finding",
            ):
                with self.subTest(outdated=outdated, body=body):
                    self.threads[0]["comments"]["nodes"][0]["body"] = body
                    with self.assertRaisesRegex(guard.GuardError, "^unresolved_blocking_thread$"):
                        guard.verify_release(self.env, self.fetch)

    def test_minor_info_and_quoted_findings_do_not_block(self):
        self.inline = [{"id": 1}]
        self.threads = [{
            "isResolved": False, "isOutdated": False,
            "comments": {"pageInfo": {"hasNextPage": False}, "nodes": [{"body": ""}]},
        }]
        for outdated in (False, True):
            self.threads[0]["isOutdated"] = outdated
            for body in (
                "Finding 1 (MINOR): major-version wording",
                "Finding1(INFO): critical-path documentation",
                "### Minor: mentions a MAJOR release",
                "Info: explains CRITICAL terminology",
                "> Finding 1 (MAJOR): quoted example",
                "```\nFinding 1 (MAJOR): code example\n```",
                "Finding 1 (INFO)\nThis explanatory sentence mentions MAJOR.",
                "Context sentence.\n**Severity**: Minor — documents a MAJOR version.",
                "Context sentence.\n**Severity:** Info — documents the CRITICAL path.",
                "Finding 1 (Minor)\n> Finding 2 (Major): quoted example",
                "Context.\n```text\n**Severity**: Major\n```\nFinding 1 (Info)",
            ):
                with self.subTest(outdated=outdated, body=body):
                    self.threads[0]["comments"]["nodes"][0]["body"] = body
                    self.assertEqual(guard.verify_release(self.env, self.fetch)["commit_sha"], MERGE)

    def test_findings_and_emphasized_severity_on_every_visible_line_block(self):
        self.inline = [{"id": 1}]
        self.threads = [{
            "isResolved": False, "isOutdated": False,
            "comments": {"pageInfo": {"hasNextPage": False}, "nodes": [{"body": ""}]},
        }]
        for outdated in (False, True):
            self.threads[0]["isOutdated"] = outdated
            for body in (
                "Context sentence.\n\nFinding1(MAJOR): unresolved issue",
                "Finding 1 (MINOR): wording\n\nFinding 2 (MAJOR): release issue",
                "Context sentence.\n### **Finding 2 (CRITICAL)**: release issue",
                "Context sentence.\n**Severity**: Major",
                "Context sentence.\n**Severity:** Major",
                "Finding 1 (Info)\n__Severity__: Critical",
                "Context sentence.\nFinding 3: **Severity**: Major",
            ):
                with self.subTest(outdated=outdated, body=body):
                    self.threads[0]["comments"]["nodes"][0]["body"] = body
                    with self.assertRaisesRegex(guard.GuardError, "^unresolved_blocking_thread$"):
                        guard.verify_release(self.env, self.fetch)

    def test_outdated_unresolved_threads_still_require_complete_comment_coverage(self):
        self.inline = [{"id": 1}]
        self.threads = [{
            "isResolved": False, "isOutdated": True,
            "comments": {"pageInfo": {"hasNextPage": True}, "nodes": [{"body": "Minor: first page"}]},
        }]
        with self.assertRaisesRegex(guard.GuardError, "^thread_coverage_incomplete$"):
            guard.verify_release(self.env, self.fetch)


if __name__ == "__main__":
    unittest.main()
