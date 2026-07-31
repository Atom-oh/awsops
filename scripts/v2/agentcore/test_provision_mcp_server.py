"""ADR-017: regression for provision.ensure_mcp_server_targets.

Same discipline as test_provision_skip.py — a SKIP-worthy state (no endpoints configured, no
stored credential) must never surface as ERR, or a perfectly valid flag-off/not-yet-onboarded
config would make `make agentcore` fail.

Also covers the fixes from the 2026-07-31 kiro review of PR #194:
  - CRITICAL: disabling a preset (flag off / endpoint removed) must RETIRE (delete) any target +
    credential provider a prior run left live, not just stop touching them.
  - CRITICAL: a live legacy lambda target for the same kind must be deleted before the mcpServer
    target is created — checking `lambda_arns` (tf config) alone can't see a leftover target
    object from a prior run.
  - WARNING: a malformed stored credential (not a dict) must SKIP, not crash the whole run.
  - WARNING: a credential-provider wiring change (location/param/prefix) with an unchanged
    endpoint must still be detected as drift and trigger an update.

Runs with `python3 -m unittest test_provision_mcp_server` (no network/boto3 control-plane
calls in the SKIP paths).
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import provision  # noqa: E402

_DATADOG_PRESET = {
    "datadog-mcp-server-target": {
        "gateway": "external-obs",
        "preset_key": "datadog",
        "description": "Datadog official MCP",
        "auth": {"mode": "api_key", "credential_location": "HEADER", "credential_parameter_name": "Authorization", "credential_prefix": "Bearer "},
    }
}

_CLICKHOUSE_PRESET = {
    "clickhouse-mcp-server-target": {
        "gateway": "external-obs",
        "preset_key": "clickhouse",
        "description": "ClickHouse official MCP",
        "auth": {"mode": "api_key", "credential_location": "HEADER", "credential_parameter_name": "Authorization", "credential_prefix": "Bearer "},
    }
}

_CLICKHOUSE_LAMBDA_TARGETS = {
    "clickhouse-mcp-target": {"gateway": "external-obs", "lambda_key": "clickhouse-mcp", "description": "", "tools": []},
}


def _ctrl_with_targets(targets_by_gw=None):
    """A Mock() ctrl whose list_gateway_targets returns the given {gw_id: [target,...]} map in the
    shape provision._list_all expects (an 'items' key), and whose get_gateway_target returns a
    target's full body (including credentialProviderConfigurations) by targetId."""
    targets_by_gw = targets_by_gw or {}
    ctrl = mock.Mock()
    ctrl.list_gateway_targets.side_effect = lambda gatewayIdentifier, **_kw: {"items": targets_by_gw.get(gatewayIdentifier, [])}
    by_id = {t["targetId"]: t for ts in targets_by_gw.values() for t in ts}
    ctrl.get_gateway_target.side_effect = lambda gatewayIdentifier, targetId: by_id[targetId]
    return ctrl


class TestEnsureMcpServerTargets(unittest.TestCase):
    def setUp(self):
        provision.report.clear()

    def test_no_endpoints_configured_is_skip_not_err(self):
        ctrl = _ctrl_with_targets()
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, {"official_mcp_endpoints": {}, "lambda_arns": {}, "region": "ap-northeast-2"}, {"external-obs": "gw-1"})
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])
        ctrl.create_gateway_target.assert_not_called()

    def test_endpoint_configured_but_no_credential_is_skip(self):
        ctrl = _ctrl_with_targets()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])
        ctrl.create_gateway_target.assert_not_called()

    def test_conflicting_lambda_in_tf_config_is_warn_not_err(self):
        # datadog was never a lambda TARGETS entry (legacy_target_name -> None), so the tf-config
        # check is purely informational here: it must WARN, never ERR/block, and must not crash.
        ctrl = _ctrl_with_targets()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {"datadog-mcp": "arn:aws:lambda:...:function:x-agent-datadog-mcp"},
              "region": "ap-northeast-2", "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        self.assertIn("WARN", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])

    def test_disabling_preset_retires_existing_target_and_credential_provider(self):
        # CRITICAL #1 regression: a target from a prior run exists; the endpoint is now gone
        # (flag off or removed from official_mcp_endpoints) — it must be DELETED, not left live.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {}, "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")
        self.assertIn("RETIRED", {r[1] for r in provision.report})

    def test_live_legacy_lambda_target_is_deleted_before_cutover(self):
        # CRITICAL #2 regression: clickhouse-mcp-target (the OLD lambda target) is still LIVE on
        # external-obs even though lambda_arns no longer has clickhouse-mcp (tf already applied the
        # removal) — the live object, not the tf config, is what must gate/trigger cleanup. It must
        # be deleted before the new mcpServer target is created, so the two can never coexist.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "clickhouse-mcp-target", "targetId": "t-legacy"}]})
        ctrl.get_api_key_credential_provider.side_effect = _raise_not_found
        ctrl.create_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ctrl.create_gateway_target.return_value = {"targetId": "t-new"}
        ac = {"official_mcp_endpoints": {"clickhouse": "https://ch.example.com/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value={"clickhouse": {"token": "tok"}}):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-legacy")
        ctrl.create_gateway_target.assert_called_once()
        self.assertIn(("target:clickhouse-mcp-target", "RETIRED"), [(r[0], r[1]) for r in provision.report])
        self.assertIn(("target:clickhouse-mcp-server-target", "CREATED"), [(r[0], r[1]) for r in provision.report])

    def test_malformed_secret_value_does_not_crash(self):
        # WARNING #1 regression: a stored credential that is a string (not a dict) must SKIP the
        # preset, not raise AttributeError and abort the whole provisioner run.
        ctrl = _ctrl_with_targets()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value={"datadog": "not-a-dict"}):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})  # must not raise
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])
        ctrl.create_gateway_target.assert_not_called()

    def test_credential_provider_drift_triggers_update_even_with_unchanged_endpoint(self):
        # WARNING #2 regression: endpoint is unchanged but the credential-provider wiring (e.g.
        # catalog.py's credential_parameter_name) differs from what's live — must still UPDATE.
        live_target = {
            "name": "datadog-mcp-server-target", "targetId": "t-1",
            "targetConfiguration": {"mcp": {"mcpServer": {"endpoint": "https://mcp.datadoghq.com/v1/mcp"}}},
            "credentialProviderConfigurations": [{
                "credentialProviderType": "API_KEY",
                "credentialProvider": {"apiKeyCredentialProvider": {
                    "providerArn": "arn:provider", "credentialLocation": "HEADER",
                    "credentialParameterName": "X-Api-Key", "credentialPrefix": "",  # stale wiring
                }},
            }],
            "description": "Datadog official MCP",
        }
        ctrl = _ctrl_with_targets({"gw-1": [live_target]})
        ctrl.get_api_key_credential_provider.side_effect = None
        ctrl.get_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value={"datadog": {"token": "tok"}}):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.update_gateway_target.assert_called_once()
        self.assertIn(("target:datadog-mcp-server-target", "UPDATED"), [(r[0], r[1]) for r in provision.report])


def _raise_not_found(*_a, **_kw):
    from botocore.exceptions import ClientError
    raise ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "no"}}, "GetApiKeyCredentialProvider")


if __name__ == "__main__":
    unittest.main()
