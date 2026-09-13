"""Offline specialist dispatch, completion and tool-contract regressions."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = {"codex/L2", "kiro-opus/L3", "kiro-gpt/L4"}
CLI = r'''#!/usr/bin/env python3
import json, os, pathlib, re, sys
args = sys.argv[1:]
state = pathlib.Path(os.environ["FAKE_STATE"])
kiro = pathlib.Path(sys.argv[0]).name == "kiro-cli"
if args == ["--version"]:
    print("kiro-cli fixture")
    sys.exit(0)
prompt = args[1] if kiro else args[-1]
if kiro and "startup check" in prompt:
    assert args[args.index("--agent")+1] == "pr-review-readonly"
    assert sys.stdin.read() == ""
    print("WRONG" if os.environ.get("BAD_PREFLIGHT") else "PONG")
    sys.exit(0)
tag = "codex" if not kiro else ("kiro-opus" if "claude-opus-5" in args else "kiro-gpt")
lens = re.search(r"Review lens: (L[2-5])", prompt).group(1)
nonce = re.search(r"Cell nonce: ([0-9a-f]{32})", prompt).group(1)
(state / (tag+"-"+lens+".prompt")).write_text(prompt)
if kiro:
    path = re.search(r"saved at this file path: (.*?) \(already", prompt).group(1)
    assert pathlib.Path(path).read_text().endswith("FULL_DIFF_TAIL\n")
    assert "FULL_DIFF_TAIL" not in prompt
else:
    assert sys.stdin.read().endswith("FULL_DIFF_TAIL\n")
mode = os.environ.get("FAIL_MODE") if tag == "kiro-opus" else ""
if mode == "missing":
    sys.exit(0)
if mode == "nonce":
    nonce = "f"*32
if mode == "tool-only":
    print("Reading the file (using tool: read)")
    sys.exit(0)
if mode == "fallback":
    print("no agent with name pr-review-readonly. Falling back to user specified default", file=sys.stderr)
if mode == "quota":
    print("MONTHLY_REQUEST_COUNT limit reached", file=sys.stderr)
body = "REVIEW_COMPLETE: "+lens+" "+nonce+" "+json.dumps({"report": "No findings in the assigned specialist role.\n"})
if not kiro and "--json" in args:
    for event in (
        {"type":"turn.started"},
        {"type":"item.completed","item":{"id":"reply","type":"agent_message","text":body}},
        {"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}},
    ):
        print(json.dumps(event))
else:
    print(body)
'''


class SpecialistRoles(unittest.TestCase):
    def run_panel(self, **extra):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        binaries = root / "bin"
        binaries.mkdir()
        for name in ("codex", "kiro-cli"):
            cli = binaries / name
            cli.write_text(CLI)
            cli.chmod(0o755)
        lenses = root / "lenses"
        lenses.mkdir()
        for lens in ("L2", "L3", "L4", "L5"):
            text = (
                "TRUSTED_BASE_POLICY\n"
                "Stay inside your assigned lens below — do not comment on other lenses "
                "(other agents\ncover those independently).\n\n"
                "LENS: "+lens+"\nReview this boundary.\n"
            )
            if lens == "L5":
                text += "Check ADR status, commands, links and documentation.\n"
            (lenses / (lens + ".txt")).write_text(text)
        diff = root / "diff"
        diff.write_text("x" * 150000 + "\nFULL_DIFF_TAIL\n")
        env = {"PATH": f"{binaries}:/usr/bin:/bin", "FAKE_STATE": str(root),
               "ROLE_REVIEW": "1", "PANEL_RETRIES": "1", "PANEL_TIMEOUT": "3",
               "KIRO_PANEL_TIMEOUT": "3", "KIRO_PREFLIGHT_TIMEOUT": "3", **extra}
        result = subprocess.run(["bash", str(ROOT / "scripts/pr-review/run-panel.sh"),
                                 str(diff), str(lenses), str(root / "work")],
                                env=env, cwd=root, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        return root

    def test_exact_three_roles_full_input_and_nonce_frames(self):
        root = self.run_panel()
        work = root / "work"
        self.assertEqual(set((work / "responded.txt").read_text().splitlines()), EXPECTED)
        self.assertFalse((work / "coverage-severe.flag").exists())
        prompts = list(root.glob("*.prompt"))
        self.assertEqual(len(prompts), 3)
        roles = [p.read_text().split("SPECIALIST ROLE: ")[1].splitlines()[0] for p in prompts]
        self.assertEqual(set(roles), {"correctness", "aws", "operations"})
        self.assertTrue(all("TRUSTED_BASE_POLICY" in p.read_text() for p in prompts))
        self.assertTrue(all("do not comment on other lenses" not in p.read_text()
                            for p in prompts))
        self.assertIn("Check ADR status", (root / "kiro-gpt-L4.prompt").read_text())
        self.assertEqual(len({p.read_text() for p in (work / "slot").glob("*.nonce")}), 3)
        self.assertFalse((root / ".kiro/agents/pr-review-readonly.json").exists())

    def test_missing_invalid_and_unsafe_role_never_count_as_coverage(self):
        for mode in ("missing", "nonce", "tool-only", "fallback", "quota"):
            with self.subTest(mode=mode):
                root = self.run_panel(FAIL_MODE=mode)
                work = root / "work"
                self.assertTrue((work / "coverage-severe.flag").exists())
                self.assertIn("kiro-opus/L3", (work / "missing-cells.txt").read_text())
                self.assertNotIn("kiro-opus/L3", (work / "responded.txt").read_text())

    def test_failed_preflight_withholds_pr_input_from_kiro(self):
        root = self.run_panel(BAD_PREFLIGHT="1")
        self.assertEqual(len(list(root.glob("kiro-*.prompt"))), 0)
        self.assertTrue((root / "work/kiro-preflight.flag").exists())
        self.assertTrue((root / "work/coverage-severe.flag").exists())


if __name__ == "__main__":
    unittest.main()
