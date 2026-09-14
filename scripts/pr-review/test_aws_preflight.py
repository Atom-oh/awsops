"""Offline provider preflight contracts; every AWS command is a fixture."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parent
HELPER = SCRIPTS / "preflight-aws-session.py"
FAKE_SECRET = "s" * 40
FAKE_TOKEN = "IQoJ" + "t" * 80 + "+/=="
CONTEXT_KEYS = (
    "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_DEFAULT_PROFILE",
    "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "BOTO_CONFIG",
)
FAKE_AWS = r"""#!/usr/bin/env python3
import json, os, pathlib, sys
state = pathlib.Path(os.environ["FAKE_STATE"])
args = sys.argv[1:]
with (state / "aws-calls.jsonl").open("a") as target:
    target.write(json.dumps(args) + "\n")
# Only non-secret settings the test inspects; never snapshot the environment.
keys = json.loads(os.environ["FAKE_CONTEXT_KEYS"])
(state / "aws-context.json").write_text(json.dumps({key: os.environ.get(key) for key in keys}))
mode = os.environ.get("FAKE_MODE", "valid")
if args == ["configure", "list"]:
    if mode == "provider-error":
        sys.exit(os.environ["FAKE_SECRET"])
    source = "env" if os.environ.get("AWS_ACCESS_KEY_ID") else os.environ.get("FAKE_PROVIDER", "container-role")
    if mode == "colon-list":
        print("NAME       : VALUE                    : TYPE             : LOCATION")
        print(f"access_key : ****************TEST     : {source}   :")
        print(f"secret_key : ****************TEST     : {source}   :")
        sys.exit(0)
    print("      Name                    Value             Type    Location")
    print("      ----                    -----             ----    --------")
    print(f"access_key     ****************TEST   {source}    ")
    print(f"secret_key     ****************TEST   {source}    ")
    if mode == "malformed-provider":
        print("access_key     ****************TEST   env    AWS_ACCESS_KEY_ID")
    sys.exit(0)
if args == ["sts", "get-caller-identity", "--output", "json"]:
    # A valid cached lease need not advertise any TTL. STS validates the signature.
    if mode in ("expired", "invalid"):
        print(os.environ["FAKE_SECRET"], file=sys.stderr)
        print(os.environ["FAKE_TOKEN"])
        sys.exit(254)
    if mode == "malformed-identity":
        print("{}")
    else:
        print(json.dumps({"UserId": "AROAFIXTURE:ci-runner", "Account": "123456789012",
                          "Arn": "arn:aws:sts::123456789012:assumed-role/ci-runner/fixture"}))
    sys.exit(0)
sys.exit("unexpected AWS command")
"""


class AwsPreflight(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        cli = self.work / "aws"
        cli.write_text(FAKE_AWS)
        cli.chmod(0o755)
        self.env = {
            "PATH": f"{self.work}:/usr/bin:/bin",
            "FAKE_STATE": str(self.work), "FAKE_CONTEXT_KEYS": json.dumps(CONTEXT_KEYS),
            "FAKE_SECRET": FAKE_SECRET, "FAKE_TOKEN": FAKE_TOKEN,
            "GITHUB_ENV": str(self.work / "github-env"),
            "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://169.254.170.23/v1/credentials",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": "/runner/existing-token",
            "AWS_REGION": "ap-northeast-2", "AWS_DEFAULT_REGION": "ap-northeast-2",
            "AWS_PROFILE": "runner", "AWS_DEFAULT_PROFILE": "runner",
            "AWS_CONFIG_FILE": "/runner/config", "AWS_SHARED_CREDENTIALS_FILE": "/runner/credentials",
            "BOTO_CONFIG": "/runner/boto",
        }

    def run_preflight(self):
        return subprocess.run(
            ["python3", str(HELPER)], cwd=self.work, env=self.env,
            capture_output=True, text=True, timeout=5,
        )

    def calls(self):
        path = self.work / "aws-calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_no_leaks(self, result):
        # Avoid assertion messages containing the credential or captured output.
        for secret in (FAKE_SECRET, FAKE_TOKEN, "ASIA" + "X" * 16):
            self.assertFalse(secret in result.stdout + result.stderr, "credential leaked in output")
        self.assertNotIn("::add-mask::", result.stdout)

    def test_preflight_keeps_ambient_provider_and_signing_settings(self):
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0)
        context = json.loads((self.work / "aws-context.json").read_text())
        self.assertEqual(context, {key: self.env.get(key) for key in CONTEXT_KEYS})
        self.assertEqual(self.calls(), [
            ["configure", "list"], ["sts", "get-caller-identity", "--output", "json"],
        ])
        self.assertIn("preflight", result.stdout.lower())
        self.assertNotIn("refreshed", result.stdout.lower())
        self.assert_no_leaks(result)

    def test_no_credential_export_or_files_even_with_github_env_present(self):
        target = Path(self.env["GITHUB_ENV"])
        target.write_text("EXISTING_SETTING=keep\n")
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "EXISTING_SETTING=keep\n", "GITHUB_ENV was modified")
        self.assert_no_leaks(result)
        self.assertEqual({path.name for path in self.work.iterdir()},
                         {"aws", "github-env", "aws-calls.jsonl", "aws-context.json"})

    def test_valid_cached_lease_needs_no_ttl_or_github_env(self):
        del self.env["GITHUB_ENV"]
        # The removed floor must not reject a valid cached provider.
        self.env["AWS_SESSION_MIN_TTL"] = "9999999999"
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0)
        self.assert_no_leaks(result)

    def test_colon_delimited_cli_provider_table_is_supported(self):
        self.env["FAKE_MODE"] = "colon-list"
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0)
        self.assert_no_leaks(result)

    def test_invalid_expired_or_malformed_provider_fails_without_leaking(self):
        for mode in ("provider-error", "expired", "invalid", "malformed-provider", "malformed-identity"):
            with self.subTest(mode=mode):
                self.env["FAKE_MODE"] = mode
                result = self.run_preflight()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(Path(self.env["GITHUB_ENV"]).exists())
                self.assert_no_leaks(result)

    def test_other_provider_is_rejected_without_hiding_ambient_configuration(self):
        for provider in ("env", "shared-credentials-file", "assume-role", "assume-role-with-web-identity", "None"):
            with self.subTest(provider=provider):
                self.env["FAKE_PROVIDER"] = provider
                (self.work / "aws-calls.jsonl").unlink(missing_ok=True)
                result = self.run_preflight()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [["configure", "list"]])
                self.assert_no_leaks(result)

    def test_shadowing_static_keys_are_not_silently_removed_for_preflight(self):
        self.env.update(
            AWS_ACCESS_KEY_ID="ASIA" + "X" * 16,
            AWS_SECRET_ACCESS_KEY=FAKE_SECRET, AWS_SESSION_TOKEN=FAKE_TOKEN,
        )
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [["configure", "list"]])
        self.assertFalse(Path(self.env["GITHUB_ENV"]).exists())
        self.assert_no_leaks(result)

    def test_missing_pod_identity_source_fails_before_any_cli_call(self):
        for key in ("AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"):
            with self.subTest(key=key):
                value = self.env.pop(key)
                result = self.run_preflight()
                self.env[key] = value
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [])
                self.assertFalse(Path(self.env["GITHUB_ENV"]).exists())
                self.assert_no_leaks(result)

    def test_cli_timeout_is_fail_closed_and_does_not_log_provider_output(self):
        spec = importlib.util.spec_from_file_location("aws_preflight", HELPER)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        output = io.StringIO()
        error = subprocess.TimeoutExpired(["aws"], 45, output=FAKE_SECRET, stderr=FAKE_TOKEN)
        with patch.dict(os.environ, self.env, clear=True), \
             patch.object(helper.subprocess, "run", side_effect=error), \
             redirect_stdout(output), redirect_stderr(output):
            self.assertEqual(helper.main(), 1)
        self.assertFalse(FAKE_SECRET in output.getvalue() or FAKE_TOKEN in output.getvalue())


if __name__ == "__main__":
    unittest.main()
