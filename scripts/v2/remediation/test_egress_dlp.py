"""Parity tests for egress_dlp.py (mirror web/lib/egress-dlp.test.ts). stdlib unittest."""
import base64
import json
import unittest

import egress_dlp as dlp


class RedactEgressTest(unittest.TestCase):
    def test_masks_aws_access_key(self):
        out, cats = dlp.redact_egress({"text": "key is AKIAIOSFODNN7EXAMPLE here"})
        self.assertNotIn("AKIAIOSFODNN7EXAMPLE", json.dumps(out))
        self.assertIn("aws-key", cats)

    def test_masks_arn(self):
        out, _ = dlp.redact_egress({"text": "see arn:aws:iam::180294183052:role/AdminRole now"})
        self.assertNotIn("180294183052:role/AdminRole", json.dumps(out))

    def test_masks_private_and_metadata_ips(self):
        out, _ = dlp.redact_egress({"text": "host 10.0.0.5 and 169.254.169.254 and 172.16.3.9"})
        s = json.dumps(out)
        for ip in ("10.0.0.5", "169.254.169.254", "172.16.3.9"):
            self.assertNotIn(ip, s)

    def test_catches_base64_encoded_secret_via_blob(self):
        enc = base64.b64encode(b"AKIAIOSFODNN7EXAMPLE-and-a-secret-payload-here").decode()
        out, cats = dlp.redact_egress({"text": "data: " + enc})
        self.assertNotIn(enc, json.dumps(out))
        self.assertIn("blob", cats)

    def test_recurses_all_string_fields(self):
        out, _ = dlp.redact_egress({"text": "ok", "blocks": [{"text": "leak AKIAIOSFODNN7EXAMPLE"}], "channel": "#ops"})
        self.assertNotIn("AKIAIOSFODNN7EXAMPLE", json.dumps(out))

    def test_size_cap_truncates_not_blob(self):
        out, _ = dlp.redact_egress({"text": "x" * 5000})
        t = out["text"]
        self.assertLessEqual(len(t), 3010)
        self.assertTrue(t.endswith("…[truncated]"))

    def test_idempotent_on_clean_text(self):
        out, cats = dlp.redact_egress({"text": "a normal incident note, nothing secret"})
        self.assertEqual(out["text"], "a normal incident note, nothing secret")
        self.assertEqual(cats, [])


class ChannelAllowlistTest(unittest.TestCase):
    def test_allowed_passes(self):
        dlp.assert_channel_allowed("#incidents", ["#incidents", "#ops"])

    def test_disallowed_raises(self):
        with self.assertRaises(dlp.ChannelNotAllowed):
            dlp.assert_channel_allowed("#random", ["#incidents"])

    def test_empty_allowlist_deny_all(self):
        with self.assertRaises(dlp.ChannelNotAllowed):
            dlp.assert_channel_allowed("#incidents", [])
        with self.assertRaises(dlp.ChannelNotAllowed):
            dlp.assert_channel_allowed("#incidents", None)


if __name__ == "__main__":
    unittest.main()
