"""Known IDs preserve baseline routing and ADR-017 behavior after read failures."""
import os
import sys
from unittest import TestCase, mock

sys.path.insert(0, os.path.dirname(__file__))
import provision


AC = {"region": "ap-northeast-2", "role_arn": "arn:aws:iam::123456789012:role/fixture",
      "ecr_uri": "fixture.example.test/agent", "lambda_arns": {}}
PRESET_NAME = "datadog-mcp-server-target"
PRESET = {PRESET_NAME: provision.catalog.MCP_SERVER_TARGETS[PRESET_NAME]}
ENDPOINT = "https://mcp.datadoghq.com/v1/mcp"


def gateway(key):
    return {"name": f"awsops-v2-{key}-gateway", "gatewayId": f"gw-{key}",
            "status": "READY", "roleArn": AC["role_arn"], "protocolType": "MCP",
            "authorizerType": "AWS_IAM",
            "description": provision.catalog.GATEWAY_DESCRIPTIONS[key]}


class TestGatewayIdentityAndTeardown(TestCase):
    def setUp(self):
        provision.report.clear()

    def test_known_unready_gateway_still_runs_every_preset_teardown_reason(self):
        cases = [
            ({}, {}, {}, True),
            ({"datadog": ENDPOINT}, {}, {}, False),
            ({"datadog": "http://invalid.example"}, {"datadog": "http://invalid.example"}, {}, True),
            ({"datadog": ENDPOINT}, {"datadog": ENDPOINT}, {}, True),
        ]
        for endpoints, acknowledgments, secrets, readable in cases:
            with self.subTest(endpoints=endpoints, acknowledgments=acknowledgments):
                ctrl = mock.Mock()
                ctrl.list_gateways.return_value = {"items": [gateway("external-obs")]}
                ctrl.get_gateway.side_effect = provision.ClientError(
                    {"Error": {"Code": "ThrottlingException", "Message": "not printed"}}, "GetGateway")
                ctrl.list_gateway_targets.return_value = {"items": [{"name": PRESET_NAME, "targetId": "t-1"}]}
                with mock.patch.object(provision.catalog, "GATEWAYS", ["external-obs"]), \
                     mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", PRESET), \
                     mock.patch.object(provision.catalog, "RETIRED_MCP_SERVER_TARGETS", ()):
                    ids = provision.ensure_gateways(ctrl, AC)
                    self.assertEqual(ids, {"external-obs": "gw-external-obs"})
                    provision.ensure_mcp_server_targets(
                        ctrl, {**AC, "official_mcp_endpoints": endpoints,
                               "official_mcp_read_only_ack": acknowledgments},
                        ids, secrets=secrets, secrets_read_ok=readable)
                ctrl.delete_gateway_target.assert_called_once_with(
                    gatewayIdentifier="gw-external-obs", targetId="t-1")
                ctrl.delete_api_key_credential_provider.assert_called_once()
                ctrl.create_gateway_target.assert_not_called()

    def test_unconfirmed_runtime_blocks_new_presets_but_not_tombstones(self):
        ctrl = mock.Mock()
        ctrl.list_gateway_targets.return_value = {"items": [{"name": "removed-target", "targetId": "old"}]}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", PRESET), \
             mock.patch.object(provision.catalog, "RETIRED_MCP_SERVER_TARGETS", (("removed-target", "removed"),)):
            provision.ensure_mcp_server_targets(
                ctrl, {**AC, "official_mcp_endpoints": {"datadog": ENDPOINT},
                       "official_mcp_read_only_ack": {"datadog": ENDPOINT}},
                {"external-obs": "gw-external-obs"}, secrets={"mcp:datadog": {"token": "fixture"}},
                secrets_read_ok=True, allow_provision=False)
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-external-obs", targetId="old")
        ctrl.create_api_key_credential_provider.assert_not_called()
        ctrl.update_api_key_credential_provider.assert_not_called()
        ctrl.create_gateway_target.assert_not_called()
        ctrl.update_gateway_target.assert_not_called()
        ctrl.synchronize_gateway_targets.assert_not_called()
