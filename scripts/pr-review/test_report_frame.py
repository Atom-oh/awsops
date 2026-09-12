"""Strict framing regressions; no model CLI, network, or transcript heuristics."""
import hashlib
import json
from pathlib import Path
import unittest

from report_frame import decode_report


NONCE = "0123456789abcdef0123456789abcdef"
PREFIX = f"REVIEW_COMPLETE: L2 {NONCE} "


def frame(report):
    return PREFIX + json.dumps({"report": report}, ensure_ascii=False)


class ReportFrame(unittest.TestCase):
    def test_other_nonce_source_examples_before_current_frame_are_opaque_chatter(self):
        current = frame("Current cell report only.\n")
        other = frame("Other cell report must not be delivered.").replace(NONCE, "f" * 32, 1)
        examples = [
            other,
            other.replace("L2", "L4", 1),
            f'REVIEW_COMPLETE: L2 {"f" * 32} {{"report":null}}',
            f'REVIEW_COMPLETE: L2 {"f" * 32} {{"report":',
        ]
        for example in examples:
            for kiro in (False, True):
                with self.subTest(example=example, kiro=kiro):
                    text = "Reading a source example\n" + example + "\n" + current
                    self.assertEqual(decode_report(text, "L2", NONCE, kiro),
                                     "Current cell report only.\n")

    def test_other_nonce_never_supplies_credit_or_hides_nonfinal_or_wrong_lens_frames(self):
        current = frame("Current cell report.")
        other = frame("Other cell report.").replace(NONCE, "f" * 32, 1)
        wrong_lens = current.replace("L2", "L4", 1)
        for text in (
            other, current + "\n" + other, wrong_lens,
            wrong_lens + "\n" + current, other + "\n" + wrong_lens,
            current + "\n" + current,
        ):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    decode_report(text, "L2", NONCE, True)

    def test_decoding_preserves_report_data_independently_of_transport_chatter(self):
        body = (
            "MAJOR: preserve examples.\nReading file: x (using tool: read)\n"
            "Batch fs_read operation (using tool: future_tool)\n"
            "✓ Successfully read x\nSummary: 2 operations processed\n"
            "```text\nREVIEW_COMPLETE: L2\nREVIEW_COMPLETE: L4 nonce {\"report\":\"example\"}\n```\n"
            "Nested JSON: {\"report\":\"example\"}; a > prefix and ▸ Time: 6s are data.\n"
            "한국어 / 日本語 / 中文\u2028same physical frame\n"
        )
        for kiro in (False, True):
            for prefix in ("", "> ") if kiro else ("",):
                with self.subTest(kiro=kiro, prefix=prefix):
                    text = ('Untrusted chatter and tool output\nREVIEW_COMPLETE: L2\n'
                            'REVIEW_COMPLETE: $lens $nonce {"report":"source template"}\n'
                            + prefix + frame(body) + "\n")
                    self.assertEqual(decode_report(text, "L2", NONCE, kiro), body)

    def test_only_one_final_frame_with_the_expected_lens_and_nonce_is_accepted(self):
        valid = frame("No findings.")
        for invalid in [
            "", "No findings.", "REVIEW_COMPLETE: L2", PREFIX, valid + "\nStill working",
            valid + "\n" + valid, frame("Earlier report") + "\n" + valid,
            valid.replace("L2", "L4", 1), valid.replace("L2", "L9", 1),
            valid.replace(NONCE, "f" * 32, 1), valid.replace(NONCE, "", 1),
            valid.replace(NONCE, NONCE[:-1], 1), valid.replace(NONCE, NONCE.upper(), 1),
            "REVIEW_COMPLETE: L9 " + NONCE + ' {"report":"other"}\n' + valid,
            valid + "\nReading more (using tool: read)",
            PREFIX + '{"report":\n"No findings."}',
            PREFIX + '{"report":"unescaped\nnewline"}',
            PREFIX + '{"report":"raw\x00control"}',
            "```json\n" + valid + "\n```",
        ]:
            with self.subTest(text=invalid):
                with self.assertRaises(ValueError):
                    decode_report(invalid, "L2", NONCE, True)
        for nonce in ("", "bad", NONCE[:-1], "0" * 33):
            with self.subTest(expected_nonce=nonce):
                with self.assertRaises(ValueError):
                    decode_report(valid, "L2", nonce)

    def test_strict_json_schema_rejects_duplicate_keys_types_and_invisible_reports(self):
        payloads = [
            "null", "[]", '"report"', "{}", '{"report":null}', '{"report":true}', '{"report":1}',
            '{"report":[]}', '{"report":{}}', '{"report":"one","report":"two"}',
            '{"report":"valid","extra":1}', '{"report":NaN}', '{"report":Infinity}',
            '{"report":"valid"} trailing', '{"report":"valid"}{"report":"other"}',
            '{"report":"unpaired \\ud800"}',
        ]
        payloads += [json.dumps({"report": report}) for report in (
            "", " \t\r\n", "\x00\x01\x07", "\u200b\u200c\u200d\ufeff", "\u034f",
            "\x1b[31m\x1b[0m", "\x1b]title\x07",
        )]
        for payload in payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    decode_report(PREFIX + payload, "L2", NONCE)

    def test_kiro_prefix_ansi_whitespace_and_one_numeric_footer_are_transport_only(self):
        body = "No findings.\n"
        text = "\x1b[32m  > \x1b[0m" + frame(body) + " \t\r\n"
        for footer in ("", "\n ▸ Time: 6.25s\n", " ▸ Credits: 0.03 • Time: 2m 6s\n"):
            with self.subTest(footer=footer):
                self.assertEqual(decode_report(text + footer, "L2", NONCE, True), body)
        self.assertEqual(decode_report(" \t" + frame(body) + "\t \n\n", "L2", NONCE), body)
        for suffix in ("▸ Time: still reviewing", "▸ Time: 6s\n▸ Time: 7s", "▸ Time: 6s\nnoise"):
            with self.subTest(suffix=suffix):
                with self.assertRaises(ValueError):
                    decode_report(text + suffix, "L2", NONCE, True)
        for text in (frame(body) + "\n▸ Time: 6s", "> " + frame(body), "▸ Time: 6s"):
            with self.subTest(codex=text):
                with self.assertRaises(ValueError):
                    decode_report(text, "L2", NONCE)

    def test_captured_l2_and_l4_bodies_roundtrip_without_reinterpreting_their_examples(self):
        fixtures = Path(__file__).with_name("fixtures")
        provenance = json.loads((fixtures / "captured-reports.json").read_text())
        for item in provenance["reports"]:
            with self.subTest(file=item["file"]):
                raw = (fixtures / item["file"]).read_bytes()
                self.assertEqual(hashlib.sha256(raw).hexdigest(), item["body_sha256"])
                body = raw.decode("utf-8")
                self.assertIn("(using tool:", body)
                self.assertEqual(decode_report("> " + frame(body) + "\n▸ Time: 6s", "L2", NONCE, True), body)


if __name__ == "__main__":
    unittest.main()
