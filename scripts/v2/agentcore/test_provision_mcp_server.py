"""ADR-017: regression for provision.ensure_mcp_server_targets.

Same discipline as test_provision_skip.py — a SKIP-worthy state (no endpoints configured, no
stored credential, a preset's kind still on its lambda) must never surface as ERR, or a
perfectly valid flag-off/not-yet-onboarded config would make `make agentcore` fail.

Runs with `python3 -m unittest test_provision_mcp_server` (no network/boto3 control-plane
calls in the SKIP paths).
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import provision  # noqa: E402

_PRESET = {
    "datadog-mcp-server-target": {
        "gateway": "external-obs",
        "preset_key": "datadog",
        "description": "Datadog official MCP",
        "auth": {"mode": "api_key", "credential_location": "HEADER", "credential_parameter_name": "Authorization", "credential_prefix": "Bearer "},
    }
}


class TestEnsureMcpServerTargets(unittest.TestCase):
    def setUp(self):
        provision.report.clear()

    def test_no_endpoints_configured_is_skip_not_err(self):
        ctrl = mock.Mock()
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _PRESET):
            provision.ensure_mcp_server_targets(ctrl, {"official_mcp_endpoints": {}, "lambda_arns": {}, "region": "ap-northeast-2"}, {"external-obs": "gw-1"})
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])
        ctrl.create_gateway_target.assert_not_called()

    def test_endpoint_configured_but_no_credential_is_skip(self):
        ctrl = mock.Mock()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])
        ctrl.create_gateway_target.assert_not_called()

    def test_conflicting_lambda_still_deployed_is_err_not_crash(self):
        # A misconfigured tfvars: datadog-mcp lambda still in agent_lambdas AND the preset endpoint
        # is set. Must ERR (loud, per ADR-017) but NOT raise — other presets/targets still process.
        ctrl = mock.Mock()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {"datadog-mcp": "arn:aws:lambda:...:function:x-agent-datadog-mcp"},
              "region": "ap-northeast-2", "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        self.assertIn("ERR", {r[1] for r in provision.report})
        ctrl.create_gateway_target.assert_not_called()


if __name__ == "__main__":
    unittest.main()
