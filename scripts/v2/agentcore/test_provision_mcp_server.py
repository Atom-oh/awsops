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
    shape provision._list_all expects (an 'items' key). get_gateway_target returns a pre-existing
    target's full body (including credentialProviderConfigurations) by targetId, defaulting
    status to READY unless the test set one — including for a NEWLY CREATED targetId (not in the
    initial map), so _wait_target_ready's poll succeeds immediately by default in every test that
    doesn't specifically exercise the not-ready/failed path."""
    targets_by_gw = targets_by_gw or {}
    ctrl = mock.Mock()
    ctrl.list_gateway_targets.side_effect = lambda gatewayIdentifier, **_kw: {"items": targets_by_gw.get(gatewayIdentifier, [])}
    by_id = {t["targetId"]: t for ts in targets_by_gw.values() for t in ts}

    def _get_gateway_target(gatewayIdentifier, targetId):
        t = by_id.get(targetId, {})
        return {**t, "status": t.get("status", "READY")}
    ctrl.get_gateway_target.side_effect = _get_gateway_target
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
        # The WARN check only runs once the preset is ACTIVE (endpoint + credential present) — an
        # inactive preset never reaches it (it's retired/skipped first) — so a credential must be
        # stored for this scenario to exercise the check at all.
        ctrl = _ctrl_with_targets()
        ctrl.get_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ctrl.create_gateway_target.return_value = {"targetId": "t-1"}
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {"datadog-mcp": "arn:aws:lambda:...:function:x-agent-datadog-mcp"},
              "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"datadog": {"token": "tok"}}, True)):
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
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"clickhouse": {"token": "tok"}}, True)):
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
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"datadog": "not-a-dict"}, True)):
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
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.update_gateway_target.assert_called_once()
        self.assertIn(("target:datadog-mcp-server-target", "UPDATED"), [(r[0], r[1]) for r in provision.report])

    def test_recreated_provider_with_unchanged_wiring_is_still_drift(self):
        # WARNING (2026-07-31 follow-up) regression: the live target's credentialProviderConfigurations
        # references an OLD providerArn (e.g. the provider was deleted+recreated by a prior retire/
        # re-enable cycle) even though location/param/prefix are unchanged. Comparing only the header
        # wiring (not providerArn) would call this "no drift" and leave the target bound to a
        # nonexistent provider — must still UPDATE.
        live_target = {
            "name": "datadog-mcp-server-target", "targetId": "t-1",
            "targetConfiguration": {"mcp": {"mcpServer": {"endpoint": "https://mcp.datadoghq.com/v1/mcp"}}},
            "credentialProviderConfigurations": [{
                "credentialProviderType": "API_KEY",
                "credentialProvider": {"apiKeyCredentialProvider": {
                    "providerArn": "arn:provider-OLD-STALE", "credentialLocation": "HEADER",
                    "credentialParameterName": "Authorization", "credentialPrefix": "Bearer ",
                }},
            }],
            "description": "Datadog official MCP",
        }
        ctrl = _ctrl_with_targets({"gw-1": [live_target]})
        ctrl.get_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider-NEW"}
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.update_gateway_target.assert_called_once()
        updated_creds = ctrl.update_gateway_target.call_args.kwargs["credentialProviderConfigurations"]
        self.assertEqual(updated_creds[0]["credentialProvider"]["apiKeyCredentialProvider"]["providerArn"], "arn:provider-NEW")

    def test_missing_credential_retires_a_previously_live_target_not_just_skips(self):
        # CRITICAL #2 (2026-07-31 follow-up) regression: endpoint stays configured but the stored
        # credential disappeared (rotated out / cleared) — a PRIOR run's target + provider are still
        # live. Must be retired, not left running with a stale/unverifiable credential.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({}, True)):  # credential gone
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")
        ctrl.create_gateway_target.assert_not_called()

    def test_legacy_target_is_retired_only_after_new_target_confirmed_created_not_before(self):
        # CRITICAL #1 (2026-07-31 follow-up) regression: the ORIGINAL fix deleted the legacy lambda
        # target BEFORE creating the new one — a create failure then left NEITHER target live
        # (outage). The new target must be confirmed CREATED/UPDATED/EXISTS first; only then may the
        # legacy target be retired.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "clickhouse-mcp-target", "targetId": "t-legacy"}]})
        ctrl.get_api_key_credential_provider.side_effect = _raise_not_found
        ctrl.create_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        from botocore.exceptions import ClientError
        ctrl.create_gateway_target.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "boom"}}, "CreateGatewayTarget")
        ac = {"official_mcp_endpoints": {"clickhouse": "https://ch.example.com/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"clickhouse": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        # The new target creation failed — the legacy target must NOT have been deleted, or the
        # kind would be unavailable through EITHER path.
        ctrl.delete_gateway_target.assert_not_called()
        self.assertIn(("target:clickhouse-mcp-server-target", "ERR"), [(r[0], r[1]) for r in provision.report])
        self.assertNotIn("RETIRED", {r[1] for r in provision.report})

    def test_secret_read_failure_does_not_retire_a_live_target(self):
        # CRITICAL (2026-07-31 second follow-up) regression: the credentials secret READ itself
        # failed (transient Secrets Manager error / malformed JSON) — must NOT be treated the same
        # as "credential intentionally removed" (which retires a live target). A transient blip on
        # a routine `make agentcore` run must never mass-deprovision every configured preset.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({}, False)):  # read FAILED
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_not_called()
        ctrl.delete_api_key_credential_provider.assert_not_called()
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertNotIn("RETIRED", {r[1] for r in provision.report})

    def test_new_target_not_yet_ready_does_not_retire_legacy_target(self):
        # CRITICAL (2026-07-31 second follow-up) regression: create_gateway_target returning 200
        # means the request was ACCEPTED, not that the target is usable yet. If it never reaches
        # READY (stuck CREATING, or a terminal FAILED status), the legacy lambda target must stay
        # live — cutover is not confirmed, so retiring the old tool would cause an outage.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "clickhouse-mcp-target", "targetId": "t-legacy"}]})
        ctrl.get_api_key_credential_provider.side_effect = _raise_not_found
        ctrl.create_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ctrl.create_gateway_target.return_value = {"targetId": "t-new"}
        # Override the default READY-immediately behavior: the new target reports FAILED.
        ctrl.get_gateway_target.side_effect = lambda gatewayIdentifier, targetId: (
            {"status": "FAILED"} if targetId == "t-new" else {"status": "READY"})
        ac = {"official_mcp_endpoints": {"clickhouse": "https://ch.example.com/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"clickhouse": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_not_called()  # legacy target untouched
        self.assertNotIn("RETIRED", {r[1] for r in provision.report})
        self.assertIn(("target:clickhouse-mcp-server-target:ready", "ERR"), [(r[0], r[1]) for r in provision.report])


def _raise_not_found(*_a, **_kw):
    from botocore.exceptions import ClientError
    raise ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "no"}}, "GetApiKeyCredentialProvider")


if __name__ == "__main__":
    unittest.main()
