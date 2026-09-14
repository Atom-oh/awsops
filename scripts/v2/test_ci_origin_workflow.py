import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "ci_origin_workflow", Path(__file__).with_name("ci_origin_workflow.py"))
workflow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workflow)


class WorkflowPreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {
            "RUNNER_TEMP": self.tmp.name, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_ENV": str(Path(self.tmp.name) / "env"),
            "CI_EXPECTED_ACCOUNT_ID": "123456789012",
            "CI_EXPECTED_PROJECT": "awsops-fixture",
            "CI_EXPECTED_URL": "https://ops.example.test",
            "AWS_REGION": "ap-northeast-2",
            "CI_ROLE_ARN": "arn:aws:iam::123456789012:role/awsops-fixture-ci-release",
            "CI_SQL_READER_SECRET_ARN": "disabled",
            "CI_SMOKE_SECRET_ARN": "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:awsops-fixture/ci/deployment-verifier-Abc123",
        }

    def test_private_paths_do_not_restore_or_expose_terraform_state(self):
        prepared = workflow.prepare(self.env)
        path = Path(prepared["CI_WORK_DIR"])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((path / ".owner").stat().st_mode), 0o600)
        self.assertNotIn("CI_BACKEND_CONFIG", prepared)
        self.assertFalse((path / "backend.hcl").exists())
        self.assertIn("CI_RELEASE_MANIFEST=", Path(self.env["GITHUB_ENV"]).read_text())

    def test_actual_aws_caller_must_match_both_configured_account_and_role(self):
        caller = {"Account": "123456789012",
                  "Arn": "arn:aws:sts::123456789012:assumed-role/awsops-fixture-ci-release/test"}
        workflow.verify_caller(self.env, lambda _: caller)
        for wrong in [
            {**caller, "Account": "999999999999"},
            {**caller, "Arn": "arn:aws:sts::123456789012:assumed-role/Administrator/test"},
        ]:
            with self.subTest(caller=wrong):
                with self.assertRaises(workflow.PreparationError):
                    workflow.verify_caller(self.env, lambda _: wrong)

    def test_foreign_role_or_secret_and_injected_metadata_are_rejected_before_writes(self):
        for key, value in [
            ("CI_ROLE_ARN", "arn:aws:iam::999999999999:role/awsops-fixture-ci-release"),
            ("CI_ROLE_ARN", "arn:aws:iam::123456789012:role/Administrator"),
            ("CI_SMOKE_SECRET_ARN", self.env["CI_SMOKE_SECRET_ARN"].replace("awsops-fixture/", "another/")),
            ("CI_SQL_READER_SECRET_ARN", ""),
            ("CI_SQL_READER_SECRET_ARN", "arn:aws:secretsmanager:ap-northeast-2:999999999999:secret:ops/awsops-fixture/agent/sql-reader-Abc123"),
            ("CI_EXPECTED_URL", "https://ops.example.test/path"),
            ("CI_EXPECTED_URL", "http://ops.example.test"),
            ("GITHUB_RUN_ID", "../../foreign"),
            ("AWS_ENDPOINT_URL", "https://untrusted.example.test"),
        ]:
            with self.subTest(key=key):
                with self.assertRaises(workflow.PreparationError):
                    workflow.prepare({**self.env, key: value})
                self.assertFalse((Path(self.tmp.name) / "awsops-release-123-1").exists())

    def test_secret_payload_is_written_only_to_private_file(self):
        self.env.update(workflow.prepare(self.env))
        calls = []

        def aws(args):
            calls.append(args)
            return {"SecretString": json.dumps({"email": "verifier@example.test", "password": "private-fixture"})}

        workflow.fetch_smoke_secret(self.env, aws)
        path = Path(self.env["CI_SMOKE_CREDENTIAL_FILE"])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(json.loads(path.read_text())["email"], "verifier@example.test")
        self.assertNotIn("private-fixture", str(calls))
        self.assertNotIn("private-fixture", Path(self.env["GITHUB_ENV"]).read_text())

    def test_wrong_secret_contract_and_symlink_destination_are_rejected(self):
        self.env.update(workflow.prepare(self.env))
        with self.assertRaises(workflow.PreparationError):
            workflow.fetch_smoke_secret(self.env, lambda _: {"SecretString": '{"username":"db","password":"db-secret"}'})
        outside = Path(self.tmp.name) / "untouched"
        outside.write_text("preserve")
        Path(self.env["CI_SMOKE_CREDENTIAL_FILE"]).symlink_to(outside)
        with self.assertRaises(workflow.PreparationError):
            workflow.fetch_smoke_secret(self.env, lambda _: {"SecretString": '{"email":"v@example.test","password":"secret"}'})
        self.assertEqual(outside.read_text(), "preserve")

    def test_cleanup_requires_our_receipt_and_does_not_follow_symlinks(self):
        self.env.update(workflow.prepare(self.env))
        outside = Path(self.tmp.name) / "preserve"
        outside.mkdir()
        (outside / "file").write_text("keep")
        (Path(self.env["CI_WORK_DIR"]) / "other").symlink_to(outside, target_is_directory=True)
        workflow.cleanup(self.env)
        self.assertTrue((outside / "file").exists())
        self.assertFalse(Path(self.env["CI_WORK_DIR"]).exists())


if __name__ == "__main__":
    unittest.main()
