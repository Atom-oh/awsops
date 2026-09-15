"""Presentation failures must not earn panel or final-review coverage."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from report_frame import decode_report
from review_scope import decision, expected_cells


NONCE = "a" * 32
MODULE = Path(__file__).parent


def frame(body):
    return "REVIEW_COMPLETE: L2 " + NONCE + " " + json.dumps({"report": body})


class FormatTests(unittest.TestCase):
    def test_decoded_examples_require_fences(self):
        for body in ("Run `echo hello`.", "Set `password` = 'synthetic-private'.",
                     "Example:\npassword='synthetic-private'"):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "unsupported_review_format"):
                decode_report(frame(body), "L2", NONCE)

    def test_valid_reference_and_fenced_example_keep_the_frame_identity(self):
        body = "Checked `validate()`.\n```sh\npassword='synthetic'\n```\nNo findings."
        self.assertEqual(decode_report(frame(body), "L2", NONCE), body)

    def test_filter_damage_cannot_credit_a_panel(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slot, responded = root / "codex-L2.txt", root / "responded.txt"
            slot.write_text(frame("Example:\n```text\n-----BEGIN PRIVATE KEY-----\n"
                                  "synthetic-private\n```\nNo findings."))
            result = subprocess.run(
                ["bash", "-c", 'source "$1"; record_result "$2" codex/L2 "$3" "$4"',
                 "fixture", str(MODULE / "lib.sh"), str(slot), str(responded), NONCE],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(slot.read_text(), "")
            self.assertFalse(responded.exists())
            self.assertNotIn("synthetic-private", result.stdout + result.stderr)

    def test_final_gate_rejects_invalid_format_despite_complete_coverage(self):
        review = ("Run `echo hello`.\nCOVERAGE: COMPLETE\nVERDICT: PASS\n")
        result, reason = decision(review, b"diff", b"diff", " ".join(expected_cells()))
        self.assertEqual(result, "fail")
        self.assertIn("format", reason.lower())


if __name__ == "__main__":
    unittest.main()
