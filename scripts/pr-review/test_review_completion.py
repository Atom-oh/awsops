"""Offline CLI-boundary regressions: python3 -m unittest discover -s scripts/pr-review -v."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts/pr-review"
MODELS = ("codex", "kiro-opus", "kiro-gpt")
LENSES = ("L2", "L3", "L4", "L5")
# Header/status spellings from the PR review of df8e0dda; paths, patterns and
# operation counts are fixture data. These are excerpts, not a full CLI capture.
KIRO_TOOL_TRANSCRIPTS = {
    "batch": (
        "Batch fs_read operation with 2 operations (using tool: read)\n"
        "Purpose: Read the review helpers.\n"
        "↱ Operation 1: Reading scripts/pr-review/lib.sh\n"
        "✓ Successfully read scripts/pr-review/lib.sh from line 1 to line 97\n"
        "↱ Operation 2: Reading scripts/pr-review/synthesize.sh\n"
        "✓ Successfully read scripts/pr-review/synthesize.sh from line 400 to line 470\n"
        "Summary: 2 operations processed\n"
    ),
    "batch_fs_read": (
        "Batch fs_read operation with 1 operations (using tool: batch_fs_read)\n"
        "Purpose: Read the review helpers.\n"
        "↱ Operation 1: Reading scripts/pr-review/lib.sh\n"
    ),
    "glob": (
        "Searching for files: scripts/pr-review/* (using tool: glob)\n"
        "scripts/pr-review/lib.sh\n"
    ),
    "code": (
        "Searching for symbols matching: panel_report_valid (using tool: code)\n"
        "scripts/pr-review/lib.sh:19:panel_report_valid() {\n"
    ),
    "shell": (
        "I will run the following command: sed -n '1,97p' scripts/pr-review/lib.sh (using tool: shell)\n"
        "Purpose: Inspect completion validation.\n"
        "set -uo pipefail\n"
    ),
    "concatenated": (
        "...to line 470Searching for: panel_report_valid (using tool: grep)"
        "I will run the following command: cat scripts/pr-review/lib.sh (using tool: shell)\n"
        "Purpose: Inspect completion validation.\n"
    ),
    "success": (
        "✓ Successfully read scripts/pr-review/synthesize.sh from line 400 to line 470\n"
        "Purpose: Inspect completion validation.\n"
    ),
    "summary": (
        "Summary: 2 operations processed\n"
        "↱ Operation 1: Reading scripts/pr-review/lib.sh\n"
    ),
    "quoted_argument_then_tool": (
        'Searching for: "(using tool: read)" (using tool: future_tool)Search results follow\n'
        "scripts/pr-review/lib.sh:35\n"
    ),
}
FAKE_CLI = r"""#!/usr/bin/env python3
import json, os, pathlib, re, signal, subprocess, sys, time
state = pathlib.Path(os.environ["FAKE_STATE"])
cli = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if cli == "aws":
    sys.exit("AWS calls are forbidden in panel/chair fixtures")
prompt = args[args.index("-p") + 1] if cli == "claude" else args[1] if cli == "kiro-cli" else args[-1]
if cli == "claude":
    key = "chair-primary" if "fable" in os.environ["ANTHROPIC_MODEL"] else "chair-fallback"
    body = "Summary: reviewed the diff and all lens reports.\nVERDICT: PASS\n"
    assert "--strict-mcp-config" in args
    assert args[args.index("--allowedTools") + 1] == "Read Grep Glob"
else:
    lens = re.search(r"LENS: (L[2-5])", prompt).group(1)
    model = "codex" if cli == "codex" else {"claude-opus-5": "kiro-opus", "gpt-5.6-terra": "kiro-gpt"}[args[args.index("--model") + 1]]
    key = model + "-" + lens
    body = "No findings after reviewing this lens.\nREVIEW_COMPLETE: " + lens + "\n"
    if cli == "kiro-cli":
        assert "--trust-tools=read,grep,fs_read" in args and "--no-interactive" in args
        assert args[args.index("--wrap") + 1] == "never"
        diff_path = re.search(r"saved at this file path: (.*?) \(already", prompt).group(1)
        assert pathlib.Path(diff_path).read_text() == "DIFF_DATA_ONLY\n"
        assert "DIFF_DATA_ONLY" not in prompt
    else:
        assert args[:4] == ["exec", "-s", "read-only", "--skip-git-repo-check"]
        assert sys.stdin.read() == "DIFF_DATA_ONLY\n"
countfile = state / (key + ".count")
count = int(countfile.read_text()) + 1 if countfile.exists() else 1
countfile.write_text(str(count))
plan = json.loads((state / "plan.json").read_text())
modes = plan.get(key, ["success"])
mode = modes[min(count - 1, len(modes) - 1)]
(state / (key + ".prompt")).write_text(prompt)
if mode in ("tool-chatter", "tool-report"):
    assert cli == "kiro-cli"
    transcript = (state / "tool-transcript.txt").read_text()
    final = body if mode == "tool-report" else "REVIEW_COMPLETE: " + lens + "\n"
    body = "I'll inspect the diff.\n" + transcript + "> " + final
if mode == "missing":
    sys.exit(0)
if mode == "partial":
    body = "Reading the diff with a tool; review still in progress.\n"
if mode == "wrong":
    body = body.replace("REVIEW_COMPLETE: " + lens, "REVIEW_COMPLETE: L9")
if mode == "duplicate":
    body += body.splitlines()[-1] + "\n"
if mode == "trailing":
    body += "Still working...\n"
if mode == "marker-only":
    body = body.splitlines()[-1] + "\n"
if mode == "ansi":
    body = "\x1b[32m" + body.replace("\n", "\x1b[0m\r\n")
if mode == "nonzero":
    body = "DISCARD_FAILED_OUTPUT\n" + body
if cli == "kiro-cli":
    # Observed assistant prefix; the synthetic footer exercises accepted numeric syntax.
    body = "\x1b[38;5;141m> \x1b[0m" + body + "\n\x1b[90m ▸ Credits: 0.03 • Time: 6s\x1b[0m\n"
print(body, end="", flush=True)
if mode in ("timeout", "hardkill"):
    if mode == "hardkill":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"])
        (state / (key + f".{count}.child")).write_text(str(child.pid))
    (state / (key + f".{count}.pid")).write_text(str(os.getpid()))
    time.sleep(30)
sys.exit(7 if mode == "nonzero" else 0)
"""


class ReviewCompletion(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.bin = self.work / "bin"
        self.bin.mkdir()
        for cli in ("codex", "kiro-cli", "claude", "aws"):
            path = self.bin / cli
            path.write_text(FAKE_CLI)
            path.chmod(0o755)
        self.lenses = self.work / "lenses"
        self.lenses.mkdir()
        for lens in LENSES:
            (self.lenses / f"{lens}.txt").write_text(f"LENS: {lens}\nReview only this lens.\n")
        self.diff = self.work / "diff"
        self.diff.write_text("DIFF_DATA_ONLY\n")
        self.out = self.work / "review.md"
        self.env = {
            "PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_STATE": str(self.work),
            "PANEL_TIMEOUT": "2", "KIRO_PANEL_TIMEOUT": "2", "PANEL_RETRIES": "2",
            "PANEL_KILL_AFTER": "0.1s", "CHAIR_TIMEOUT": "2", "CHAIR_KILL_AFTER": "0.1s",
            "GITHUB_ENV": str(self.work / "github-env"),
        }
        self.plan({})
        self.addCleanup(self.kill_leftovers)

    def kill_leftovers(self):
        for pattern in ("*.pid", "*.child"):
            for path in self.work.glob(pattern):
                try:
                    os.kill(int(path.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def plan(self, modes):
        (self.work / "plan.json").write_text(json.dumps(modes))

    def run_script(self, script, *args):
        proc = subprocess.Popen(
            ["python3" if script.endswith(".py") else "bash", str(SCRIPTS / script), *map(str, args)], cwd=ROOT,
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            self.fail(f"{script} exceeded offline test deadline")
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)

    def panel(self):
        return self.run_script("run-panel.sh", self.diff, self.lenses, self.work)

    def chair(self):
        result = self.run_script("synthesize.sh", self.diff, self.work, "303", "CI fixture", self.out)
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.out.read_text()

    def count(self, key):
        return int((self.work / f"{key}.count").read_text())

    def assert_matrix(self, missing=()):
        expected = {f"{model}/{lens}" for model in MODELS for lens in LENSES} - set(missing)
        self.assertEqual(set((self.work / "responded.txt").read_text().splitlines()), expected)
        self.assertEqual((self.work / "coverage-severe.flag").exists(), bool(missing))

    def test_nonzero_complete_looking_output_is_discarded_and_retried(self):
        self.plan({"kiro-opus-L2": ["nonzero"]})
        result = self.panel()
        self.assertIn("[rejected-preview] kiro-opus-L2 attempt=1:", result.stderr)
        self.assertIn("DISCARD_FAILED_OUTPUT", result.stderr)
        self.assert_matrix(["kiro-opus/L2"])
        self.assertEqual(self.count("kiro-opus-L2"), 2)
        self.assertEqual((self.work / "slot/kiro-opus-L2.md").read_text(), "")
        self.assertIn("VERDICT: FAIL", self.chair())
        self.assertNotIn("DISCARD_FAILED_OUTPUT", (self.work / "synth-stdin.txt").read_text())

    def test_rejected_preview_is_bounded_scrubbed_and_never_review_input(self):
        secret = "fixtureSession" + "9" * 100
        (self.work / "tool-transcript.txt").write_text(
            "Inspecting code (using tool: code)\n"
            + "\x1b[31m" + "x" * 80 + "\x1b[0m AWS_SESSION_TOKEN=" + secret
            + "\n" + "z" * 400 + "\n"
        )
        self.plan({"kiro-opus-L2": ["tool-chatter"]})
        result = self.panel()
        previews = [line.split(": ", 1)[1] for line in result.stderr.splitlines()
                    if line.startswith("[rejected-preview] kiro-opus-L2 attempt=")]
        self.assertEqual(len(previews), 2)
        for preview in previews:
            self.assertLessEqual(len(preview.encode()), 200)
            self.assertIn("[REDACTED]", preview)
            self.assertNotIn("\x1b", preview)
        self.assertNotIn(secret[:16], result.stderr)
        self.assert_matrix(["kiro-opus/L2"])
        self.assertEqual((self.work / "slot/kiro-opus-L2.md").read_text(), "")
        self.assertIn("VERDICT: FAIL", self.chair())
        self.assertNotIn(secret, (self.work / "synth-stdin.txt").read_text())
        self.assertNotIn("x" * 80, (self.work / "synth-stdin.txt").read_text())

    def test_exit_zero_requires_unique_matching_final_marker_and_report_body(self):
        for mode in ("partial", "wrong", "duplicate", "trailing", "marker-only", "missing"):
            with self.subTest(mode=mode):
                self.plan({"kiro-opus-L4": [mode]})
                self.panel()
                self.assert_matrix(["kiro-opus/L4"])
                self.assertTrue(self.chair().rstrip().endswith("VERDICT: FAIL"))

    def test_success_matrix_and_transient_retry_clear_stale_coverage(self):
        (self.work / "coverage-severe.flag").touch()
        (self.work / "missing-cells.txt").write_text("kiro-opus/L2\n")
        self.plan({"codex-L3": ["nonzero", "success"], "kiro-gpt-L5": ["ansi"]})
        result = self.panel()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_matrix()
        self.assertEqual((self.work / "missing-cells.txt").read_text(), "")
        self.assertEqual(self.count("codex-L3"), 2)
        self.assertEqual(self.count("kiro-opus-L2"), 1)
        for model in MODELS:
            for lens in LENSES:
                self.assertIn(f"REVIEW_COMPLETE: {lens}", (self.work / f"{model}-{lens}.prompt").read_text())
        self.assertTrue(self.chair().rstrip().endswith("VERDICT: PASS"))

    def test_missing_required_lens_cannot_shrink_matrix(self):
        (self.work / "missing-cells.txt").write_text("kiro-opus/L2\n")
        (self.lenses / "L5.txt").unlink()
        result = self.panel()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.work / "coverage-severe.flag").exists())
        self.assertEqual((self.work / "missing-cells.txt").read_text(), "")
        self.assertFalse(list(self.work.glob("*.count")))

    def test_realistic_tool_chatter_cannot_supply_a_required_cell(self):
        (self.work / "tool-transcript.txt").write_text(
            KIRO_TOOL_TRANSCRIPTS["batch"] + KIRO_TOOL_TRANSCRIPTS["concatenated"]
        )
        self.plan({"kiro-opus-L2": ["tool-chatter"]})
        result = self.panel()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_matrix(["kiro-opus/L2"])
        self.assertEqual(self.count("kiro-opus-L2"), 2)
        self.assertEqual((self.work / "slot/kiro-opus-L2.md").read_text(), "")
        self.assertEqual((self.work / "missing-cells.txt").read_text(), "kiro-opus/L2\n")
        self.assertTrue(self.chair().rstrip().endswith("VERDICT: FAIL"))

    def test_report_after_realistic_tool_chatter_completes_all_cells(self):
        (self.work / "tool-transcript.txt").write_text("".join(KIRO_TOOL_TRANSCRIPTS.values()))
        self.plan({
            f"{model}-{lens}": ["tool-report"]
            for model in ("kiro-opus", "kiro-gpt") for lens in LENSES
        })
        result = self.panel()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_matrix()
        self.assertTrue(self.chair().rstrip().endswith("VERDICT: PASS"))

    def test_timeout_and_hardkill_discard_complete_looking_stdout(self):
        for mode in ("timeout", "hardkill"):
            with self.subTest(mode=mode):
                self.env["KIRO_PANEL_TIMEOUT"] = "0.3"
                self.plan({"kiro-opus-L2": [mode]})
                start = time.monotonic()
                result = self.panel()
                self.assertLess(time.monotonic() - start, 5)
                self.assert_matrix(["kiro-opus/L2"])
                self.assertIn("exit=124" if mode == "timeout" else "exit=137", result.stderr)
                for path in [*self.work.glob("*.pid"), *self.work.glob("*.child")]:
                    stat = Path(f"/proc/{path.read_text()}/stat")
                    self.assertTrue(not stat.exists() or stat.read_text().split()[2] == "Z")

    def test_chair_nonzero_output_cannot_supply_pass(self):
        self.panel()
        self.assert_matrix()
        self.plan({"chair-primary": ["nonzero"], "chair-fallback": ["nonzero"]})
        review = self.chair()
        self.assertTrue(review.rstrip().endswith("VERDICT: FAIL"))
        self.assertNotIn("DISCARD_FAILED_OUTPUT", review)
        self.assertTrue((self.work / "chair-failed.flag").exists())
        self.assertEqual(self.count("chair-primary"), 2)
        self.assertEqual(self.count("chair-fallback"), 2)

    def test_chair_fallback_after_invalid_primary(self):
        self.panel()
        self.assert_matrix()
        self.plan({"chair-primary": ["partial"]})
        self.assertTrue(self.chair().rstrip().endswith("VERDICT: PASS"))
        self.assertEqual(self.count("chair-primary"), 2)
        self.assertEqual(self.count("chair-fallback"), 1)
        self.assertFalse((self.work / "chair-failed.flag").exists())

    def test_chair_exit_zero_requires_report_body_and_unique_final_verdict(self):
        self.panel()
        self.assert_matrix()
        for mode in ("marker-only", "duplicate", "trailing"):
            with self.subTest(mode=mode):
                self.plan({"chair-primary": [mode], "chair-fallback": [mode]})
                self.assertTrue(self.chair().rstrip().endswith("VERDICT: FAIL"))

    def test_chair_timeout_and_hardkill_are_not_fast_fail_retried(self):
        self.panel()
        self.assert_matrix()
        self.env["CHAIR_TIMEOUT"] = "0.3"
        self.plan({"chair-primary": ["timeout"], "chair-fallback": ["hardkill"]})
        self.assertTrue(self.chair().rstrip().endswith("VERDICT: FAIL"))
        self.assertEqual(self.count("chair-primary"), 1)
        self.assertEqual(self.count("chair-fallback"), 1)

    def test_kiro_footer_parser_accepts_only_cosmetic_suffix_after_completed_report(self):
        report = "\x1b[38;5;141m> \x1b[0mNo findings.\r\nREVIEW_COMPLETE: L2\r\n"
        usage = "\x1b[90m ▸ Credits: 0.03 • Time: 2m 6s\x1b[0m\n\n"
        cases = [
            (report + usage, True),
            (report + " ▸ Time: 6.25s\n", True),
            (report.replace("REVIEW_COMPLETE", "> REVIEW_COMPLETE") + usage, True),
            (usage, False),
            ("REVIEW_COMPLETE: L2\n" + usage, False),
            (report.replace("L2", "L4") + usage, False),
            (report + usage + "Reading file: more.py (using tool: read)\n", False),
            (report + " ▸ Credits: 0.03 • Time: still reviewing\n", False),
            (report + usage + usage, False),
            ("> I'll read the diff.\nReading file: diff (using tool: read)\n"
             "Tool output: several diff lines\n> REVIEW_COMPLETE: L2\n" + usage, False),
            ("> I'll read the diff.\nReading file: diff (using tool: fs_read)\n"
             "Tool output: several diff lines\n" + report + usage, True),
            ("> Earlier draft findings.\nReading file: more.py (using tool: read)\n"
             "Tool output: several diff lines\n> REVIEW_COMPLETE: L2\n" + usage, False),
            ("> The parser mishandles (using tool: read) in quoted findings.\n"
             "A finding may quote `(using tool: fs_read)` without starting a tool.\n"
             "REVIEW_COMPLETE: L2\n" + usage, True),
            ("> I'll search the base.\nSearching for pattern: foo (using tool: grep)\n"
             "Tool output: foo\n> REVIEW_COMPLETE: L2\n" + usage, False),
        ]
        for text, valid in cases:
            with self.subTest(text=text):
                self.assert_kiro_report(text, valid)

    def assert_kiro_report(self, text, valid):
        path = self.work / "kiro-opus-L2.md"
        path.write_text(text)
        result = subprocess.run(
            ["bash", "-c", '. "$1"; panel_report_valid "$2" L2',
             "fixture", str(SCRIPTS / "lib.sh"), str(path)],
            env=self.env, capture_output=True, text=True, timeout=3,
        )
        self.assertEqual(result.returncode == 0, valid, result.stderr)

    def test_generic_tool_boundaries_require_a_new_assistant_report_body(self):
        for name, transcript in KIRO_TOOL_TRANSCRIPTS.items():
            for planning in ("", "> I'll inspect the diff.\n"):
                for marker_prefix in ("", "> "):
                    with self.subTest(name=name, planning=planning, marker_prefix=marker_prefix):
                        self.assert_kiro_report(
                            planning + transcript + marker_prefix + "REVIEW_COMPLETE: L2\n"
                            " ▸ Credits: 0.03 • Time: 6s\n", False,
                        )
            with self.subTest(name=name, completed=True):
                self.assert_kiro_report(
                    "> I'll inspect the diff.\n" + transcript
                    + "> No findings after reviewing this lens.\nREVIEW_COMPLETE: L2\n", True,
                )
            with self.subTest(name=name, missing_assistant_prefix=True):
                self.assert_kiro_report(
                    transcript + "No findings.\nREVIEW_COMPLETE: L2\n", False,
                )
            with self.subTest(name=name, tool_after_report=True):
                self.assert_kiro_report(
                    "> No findings.\nREVIEW_COMPLETE: L2\n" + transcript, False,
                )

    def test_completed_findings_can_quote_tool_headers_and_statuses(self):
        for name, transcript in KIRO_TOOL_TRANSCRIPTS.items():
            header = transcript.splitlines()[0]
            # A continuation line does not carry Kiro's assistant prefix.
            for quote in ("`", '"', "'"):
                quoted = header.replace("\\", "\\\\").replace(quote, "\\" + quote)
                with self.subTest(name=name, quote=quote):
                    self.assert_kiro_report(
                        "> MAJOR: The parser misses this CLI status.\n"
                        f"The captured line is {quote}{quoted}{quote}.\n"
                        "Require a completed report after actual tool use.\n"
                        "REVIEW_COMPLETE: L2\n ▸ Time: 6.25s\n", True,
                    )
        self.assert_kiro_report(
            KIRO_TOOL_TRANSCRIPTS["batch"]
            + '> MAJOR: Quoted `(using tool: read)` is report content.\n'
            'The string "Searching for files: * (using tool: glob)" is an example.\n'
            "REVIEW_COMPLETE: L2\n", True,
        )

    def test_labeled_session_tokens_are_scrubbed_in_environment_and_json_output(self):
        token = "IQoJ" + "t" * 80 + "/+=="
        for label in ("AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "SessionToken", "session_token"):
            for text in (f"{label}={token}\n", f'{{"{label}": "{token}"}}\n'):
                with self.subTest(label=label, quoted=text.startswith("{")):
                    result = subprocess.run(
                        ["bash", "-c", '. "$1"; strip_controls | scrub_secrets',
                         "fixture", str(SCRIPTS / "lib.sh")],
                        input=text, env=self.env, capture_output=True, text=True, timeout=3,
                    )
                    self.assertEqual(result.returncode, 0)
                    self.assertFalse(token in result.stdout, "session token leaked")
                    self.assertIn("[REDACTED]", result.stdout)
                    self.assertNotIn("/+==", result.stdout)


class WorkflowContract(unittest.TestCase):
    def test_budgets_preflight_signing_and_trusted_execution(self):
        workflow = (ROOT / ".github/workflows/pr-review.yml").read_text()
        def value(key):
            return re.search(rf"^\s+{key}: [\"']?([^\s\"']+)", workflow, re.M).group(1)
        self.assertEqual(int(value("PANEL_TIMEOUT")), 1200)
        self.assertEqual(int(value("KIRO_PANEL_TIMEOUT")), 1200)
        panel = int(value("PANEL_RETRIES")) * (max(int(value("PANEL_TIMEOUT")), int(value("KIRO_PANEL_TIMEOUT"))) + 10)
        chair = 2 * (120 + int(value("CHAIR_TIMEOUT")) + 10)
        self.assertEqual(int(value("timeout-minutes")), 90)
        self.assertLess(panel + chair + 10 * 60, 90 * 60)
        self.assertNotIn("AWS_SESSION_MIN_TTL", workflow)
        preflights = [m.start() for m in re.finditer("python3 scripts/pr-review/preflight-aws-session.py", workflow)]
        self.assertEqual(len(preflights), 2)
        self.assertLess(preflights[0], workflow.index("bash scripts/pr-review/run-panel.sh"))
        self.assertLess(workflow.index("bash scripts/pr-review/run-panel.sh"), preflights[1])
        self.assertLess(preflights[1], workflow.index("bash scripts/pr-review/synthesize.sh"))
        self.assertEqual(value("AWS_REGION"), "ap-northeast-2")
        self.assertEqual(value("ANTHROPIC_BEDROCK_BASE_URL"), "https://bedrock-runtime.ap-northeast-2.amazonaws.com")
        self.assertEqual(value("CLAUDE_CODE_USE_BEDROCK"), "1")
        self.assertIn("ref: ${{ github.event.pull_request.base.sha }}", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertNotIn("id-token: write", workflow)
        self.assertNotIn("role-to-assume:", workflow)


if __name__ == "__main__":
    unittest.main()
