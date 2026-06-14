"""Regression: provision.ensure_targets must SKIP (not ERR) a target whose Lambda is
absent from the tf output — e.g. the flag-gated notion-mcp when integrations_enabled=false.

An ERR makes main() exit non-zero, so `make agentcore` would FAIL on a perfectly valid
flag-off config. A missing Lambda for a flag-gated target is expected, not an error.

Runs with `python3 -m unittest test_provision_skip` (no network/boto3 calls — the
absent-Lambda path returns before any control-plane call).
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import provision  # noqa: E402

_TARGET = {
    "notion-mcp-target": {
        "gateway": "external-obs",
        "lambda_key": "notion-mcp",
        "description": "Notion read-only",
        "tools": [{"name": "notion_search", "inputSchema": {"type": "object", "properties": {}}}],
    }
}


class TestProvisionSkip(unittest.TestCase):
    def setUp(self):
        provision.report.clear()

    def test_absent_lambda_is_skip_not_err(self):
        ctrl = mock.Mock()
        with mock.patch.object(provision.catalog, "TARGETS", _TARGET):
            # gateway present, Lambda absent from tf output (flag off)
            provision.ensure_targets(ctrl, {"lambda_arns": {}}, {"external-obs": "gw-1"})
        statuses = {r[1] for r in provision.report}
        self.assertIn("SKIP", statuses)
        self.assertNotIn("ERR", statuses)
        # errs (what main() exits on) must be empty → make agentcore stays exit 0
        errs = [r for r in provision.report if r[1] == "ERR"]
        self.assertEqual(errs, [])
        # the absent-Lambda path returns BEFORE any control-plane call
        ctrl.create_gateway_target.assert_not_called()
        ctrl.list_gateway_targets.assert_not_called()

    def test_absent_gateway_still_errs(self):
        ctrl = mock.Mock()
        with mock.patch.object(provision.catalog, "TARGETS", _TARGET):
            provision.ensure_targets(ctrl, {"lambda_arns": {"notion-mcp": "arn:lambda"}}, {})  # gw missing
        self.assertIn("ERR", {r[1] for r in provision.report})


if __name__ == "__main__":
    unittest.main()
