"""Presentation failures must not earn panel or final-review coverage."""

import json
from pathlib import Path
import subprocess
import sys
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

    def test_section_labels_and_setext_underlines_are_prose(self):
        for body in ("Authorization:\nThe caller is checked.",
                     "**Authorization:**\nThe caller is checked.",
                     "See `Authorization`:\nThe caller is checked.",
                     "Checked `token`\n===\nThe caller is checked."):
            with self.subTest(body=body):
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

    def test_review_citations_and_same_line_labels_are_prose(self):
        for body in (
            "See [auth.ts](web/lib/auth.ts:42) for the missing guard.",
            "Authorization: The caller is checked.",
            "**Authorization:** The caller is checked.",
            "Checked `web/lib/token.ts`: the guard is missing.",
            "Per `docs/decisions/002-auth-and-login.md`: signup is closed.",
            "The guard at web/lib/auth.ts:42 is missing.",
            "Checked `Authorization`: The caller is checked.",
            "See https://example.invalid/auth:443/path for details.",
            "Authorization: None.",
            "Hardcoded credentials: none.",
            "Authorization: [See the guard](web/lib/auth.ts:42).",
            "Authorization: [guard][auth-check].",
            "See [docs](https://example.invalid/?token=ttl) for details.",
        ):
            with self.subTest(body=body):
                self.assertEqual(decode_report(frame(body), "L2", NONCE), body)
                filtered = subprocess.run(
                    [sys.executable, str(MODULE / "review_format.py"), "filter"],
                    input=body, capture_output=True, text=True,
                )
                self.assertEqual(filtered.returncode, 0, filtered.stderr)
                self.assertEqual(filtered.stdout, body)

    def test_bare_configuration_assignments_still_require_fences(self):
        for body in (
            "password: 'synthetic'",
            'secret: ["synthetic"]',
            "AWS_SESSION_TOKEN = synthetic",
            '{"api_key": "synthetic"}',
            "`password`: 'synthetic value'",
            "Authorization: Bearer synthetic",
            "password = synthetic value",
        ):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "unsupported_review_format"):
                decode_report(frame(body), "L2", NONCE)

    def test_indented_closers_cannot_hide_following_prose(self):
        for fence in ("```", "~~~"):
            for indent in (" ", "  ", "   "):
                body = (f"{fence}text\nfirst block\n{indent}{fence}\n"
                        f"password=synthetic\n{fence}text\nsecond block\n{fence}\n")
                with self.subTest(fence=fence, indent=indent), self.assertRaisesRegex(ValueError, "unsupported_review_format"):
                    decode_report(frame(body), "L2", NONCE)

    def test_longer_outer_fence_can_quote_an_indented_shorter_fence(self):
        body = "````text\n ```\npassword=synthetic\n ```\n````\nNo findings."
        self.assertEqual(decode_report(frame(body), "L2", NONCE), body)

    def test_redaction_preserves_panel_and_chair_format_acceptance(self):
        for key, value in (("aws_session_token", "synthetic" * 8),
                           ("api_key", "sk-" + "synthetic" * 8)):
            body = f"{key}: {value} was present.\nNo findings."
            self.assertEqual(decode_report(frame(body), "L2", NONCE), body)
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                slot, responded, chair = root / "panel.txt", root / "responded.txt", root / "chair.txt"
                slot.write_text(frame(body))
                panel = subprocess.run(
                    ["bash", "-c", 'source "$1"; record_result "$2" codex/L2 "$3" "$4"',
                     "fixture", str(MODULE / "lib.sh"), str(slot), str(responded), NONCE],
                    capture_output=True, text=True,
                )
                self.assertEqual(panel.returncode, 0, panel.stderr)
                self.assertTrue(responded.exists(), "Redaction must retain the completed panel")
                self.assertIn("REDACTED", slot.read_text())
                self.assertNotIn(value, slot.read_text() + panel.stdout + panel.stderr)
                result = subprocess.run(
                    ["bash", "-c", 'set -o pipefail; source "$1"; review_format_filter | scrub_secrets > "$2"; review_format_valid "$2"',
                     "fixture", str(MODULE / "lib.sh"), str(chair)],
                    input=body, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("REDACTED", chair.read_text())
                self.assertNotIn(value, chair.read_text() + result.stdout + result.stderr)

    def test_fence_language_may_have_horizontal_padding(self):
        body = "``` python \npassword='synthetic'\n```\nNo findings."
        self.assertEqual(decode_report(frame(body), "L2", NONCE), body)

    def test_final_gate_rejects_invalid_format_despite_complete_coverage(self):
        review = ("Run `echo hello`.\nCOVERAGE: COMPLETE\nVERDICT: PASS\n")
        result, reason = decision(review, b"diff", b"diff", " ".join(expected_cells()))
        self.assertEqual(result, "fail")
        self.assertIn("format", reason.lower())


if __name__ == "__main__":
    unittest.main()
