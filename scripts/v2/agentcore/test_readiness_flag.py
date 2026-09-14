"""Applied output alone enables the bounded readiness mode; no live AWS calls."""
from unittest import mock
import provision


def test_readiness_flag_ignores_ambient_values_and_requires_boolean_output():
    config = {"region": "ap-northeast-2", "project": "awsops-fixture",
              "role_arn": "arn:aws:iam::123456789012:role/fixture",
              "ecr_uri": "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/fixture"}
    for value in (None, False, "true", 1, True):
        control = mock.MagicMock()
        control.list_agent_runtimes.return_value = {"agentRuntimes": []}
        control.create_agent_runtime.return_value = {"agentRuntimeArn": "fixture", "agentRuntimeId": "fixture"}
        with mock.patch.dict(provision.os.environ, {"DEPLOYMENT_READINESS_ENABLED": "true"}), \
                mock.patch.object(provision, "_wait_runtime_ready", return_value=True), \
                mock.patch.object(provision, "log"):
            provision.ensure_runtime(control, {**config, "deployment_readiness_enabled": value}, {})
        environment = control.create_agent_runtime.call_args.kwargs["environmentVariables"]
        assert environment["DEPLOYMENT_READINESS_ENABLED"] == ("true" if value is True else "false")
