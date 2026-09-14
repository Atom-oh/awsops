"""Offline tests: real bootstrap behavior with only AWS SDK boundaries faked.

python3 -B -m unittest discover -s scripts/v2 -p test_ci_origin_verifier.py -v
"""
import contextlib
import copy
import io
import json
import logging
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from botocore.exceptions import ClientError
from botocore.session import get_session
from botocore.validate import ParamValidator

import ci_origin_verifier as verifier


ACCOUNT = "123456789012"
REGION = "ap-northeast-2"
PROJECT = "awsops-v2"
POOL = REGION + "_TestPool"
POOL_ARN = f"arn:aws:cognito-idp:{REGION}:{ACCOUNT}:userpool/{POOL}"
SECRET_NAME = PROJECT + "/ci/deployment-verifier"
SECRET_ARN = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{SECRET_NAME}-AbCd12"
EMAIL = f"ci-deployment-verifier@{PROJECT}.invalid"
SUB = "11111111-2222-4333-8444-555555555555"
OTHER_SUB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
PASSWORD = "Existing-only-InMemory-Credential9!"
VERSION = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"


class UserNotFound(ClientError):
    def __init__(self):
        super().__init__({"Error": {"Code": "UserNotFoundException", "Message": PASSWORD}}, "AdminGetUser")


class SecretNotFound(ClientError):
    def __init__(self):
        super().__init__({"Error": {"Code": "ResourceNotFoundException", "Message": PASSWORD}}, "GetSecretValue")


def denied():
    return ClientError({"Error": {"Code": "AccessDeniedException", "Message": PASSWORD}}, "fixture")


def user(status="CONFIRMED", enabled=True, sub=SUB):
    return {
        "Username": sub, "Enabled": enabled, "UserStatus": status,
        "UserAttributes": [
            {"Name": "sub", "Value": sub},
            {"Name": "email", "Value": EMAIL},
            {"Name": "email_verified", "Value": "true"},
        ],
        "UserMFASettingList": [], "MFAOptions": [],
    }


class FakeAWS:
    def __init__(self):
        self.calls = []
        self.clients = []
        self.account = ACCOUNT
        self.pool = {
            "Id": POOL, "Arn": POOL_ARN, "Name": PROJECT + "-pool", "MfaConfiguration": "OFF",
            "UsernameAttributes": ["email"], "LambdaConfig": {},
            "Policies": {"PasswordPolicy": {"MinimumLength": 12, "RequireUppercase": True,
                                          "RequireLowercase": True, "RequireNumbers": True,
                                          "RequireSymbols": True}},
        }
        self.metadata = {"ARN": SECRET_ARN, "Name": SECRET_NAME, "VersionIdsToStages": {}}
        self.secret = None
        self.version = None
        self.profile = None
        self.groups = [{"Groups": []}]
        self.fail = {}
        self.after = {}
        self.cognito = FakeCognito(self)
        self.secrets = FakeSecrets(self)
        self.sts = FakeSTS(self)

    def session(self, **kwargs):
        self.session_kwargs = kwargs
        return self

    def client(self, name, **kwargs):
        self.clients.append((name, kwargs))
        return {"sts": self.sts, "cognito-idp": self.cognito, "secretsmanager": self.secrets}[name]

    def called(self, name, params):
        self.calls.append((name, copy.deepcopy(params)))
        if name in self.fail:
            failure = self.fail[name]
            if callable(failure):
                failure(params)
            else:
                raise failure

    def completed(self, name):
        if name in self.after:
            self.after[name]()

    def writes(self):
        return [(name, params) for name, params in self.calls
                if name in ("admin_create_user", "admin_set_user_password", "put_secret_value", "admin_delete_user")]

    def existing(self):
        self.profile = user()
        self.secret = json.dumps({"email": EMAIL, "password": PASSWORD})
        self.version = VERSION
        self.metadata["VersionIdsToStages"] = {VERSION: ["AWSCURRENT"]}


class FakeSTS:
    def __init__(self, aws):
        self.aws = aws

    def get_caller_identity(self, **kwargs):
        self.aws.called("get_caller_identity", kwargs)
        return {"Account": self.aws.account}


class FakeCognito:
    exceptions = SimpleNamespace(UserNotFoundException=UserNotFound)

    def __init__(self, aws):
        self.aws = aws

    def describe_user_pool(self, **kwargs):
        self.aws.called("describe_user_pool", kwargs)
        return {"UserPool": copy.deepcopy(self.aws.pool)}

    def admin_get_user(self, **kwargs):
        self.aws.called("admin_get_user", kwargs)
        if self.aws.profile is None:
            raise UserNotFound()
        return copy.deepcopy(self.aws.profile)

    def get_paginator(self, name):
        assert name == "admin_list_groups_for_user"
        aws = self.aws

        class Pages:
            def paginate(self, **kwargs):
                aws.called("admin_list_groups_for_user", kwargs)
                yield from copy.deepcopy(aws.groups)
        return Pages()

    def admin_create_user(self, **kwargs):
        self.aws.called("admin_create_user", kwargs)
        if self.aws.profile:
            raise ClientError({"Error": {"Code": "UsernameExistsException", "Message": PASSWORD}}, "AdminCreateUser")
        self.aws.profile = user("FORCE_CHANGE_PASSWORD")
        result = copy.deepcopy(self.aws.profile)
        result["Attributes"] = result.pop("UserAttributes")
        self.aws.completed("admin_create_user")
        return {"User": result}

    def admin_set_user_password(self, **kwargs):
        self.aws.called("admin_set_user_password", kwargs)
        self.aws.profile["UserStatus"] = "CONFIRMED"
        self.aws.completed("admin_set_user_password")
        return {}

    def admin_delete_user(self, **kwargs):
        self.aws.called("admin_delete_user", kwargs)
        self.aws.profile = None
        return {}


class FakeSecrets:
    exceptions = SimpleNamespace(ResourceNotFoundException=SecretNotFound)

    def __init__(self, aws):
        self.aws = aws

    def describe_secret(self, **kwargs):
        self.aws.called("describe_secret", kwargs)
        return copy.deepcopy(self.aws.metadata)

    def get_secret_value(self, **kwargs):
        self.aws.called("get_secret_value", kwargs)
        if self.aws.secret is None:
            raise SecretNotFound()
        return {"ARN": SECRET_ARN, "Name": SECRET_NAME, "SecretString": self.aws.secret,
                "VersionId": self.aws.version, "VersionStages": ["AWSCURRENT"]}

    def put_secret_value(self, **kwargs):
        self.aws.called("put_secret_value", kwargs)
        self.aws.secret = kwargs["SecretString"]
        self.aws.version = kwargs["ClientRequestToken"]
        self.aws.metadata["VersionIdsToStages"] = {self.aws.version: ["AWSCURRENT"]}
        self.aws.completed("put_secret_value")
        return {"ARN": SECRET_ARN, "Name": SECRET_NAME, "VersionId": self.aws.version,
                "VersionStages": ["AWSCURRENT"]}


class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.aws = FakeAWS()
        self.args = ["--account", ACCOUNT, "--region", REGION, "--project", PROJECT,
                     "--user-pool-id", POOL, "--secret-arn", SECRET_ARN]
        self.session_patch = patch.object(verifier.boto3, "Session", side_effect=self.aws.session)
        self.session_patch.start()
        self.addCleanup(self.session_patch.stop)

    def invoke(self, apply=False, ok=True, args=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = verifier.main((self.args if args is None else args) + (["--apply"] if apply else []))
        output = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(PASSWORD, output)
        for _, params in self.aws.writes():
            for field in ("Password", "TemporaryPassword", "SecretString"):
                if params.get(field):
                    self.assertNotIn(params[field], output)
        self.assertEqual(code, 0 if ok else 1, output)
        return json.loads(stdout.getvalue())

    def test_default_plan_is_read_only_for_empty_metadata_and_user(self):
        result = self.invoke()
        self.assertEqual(result["mode"], "plan")
        self.assertEqual(result["action"], "create_user_and_value")
        self.assertEqual(self.aws.writes(), [])
        calls = [name for name, _ in self.aws.calls]
        self.assertGreaterEqual(calls.count("describe_secret"), 2)
        self.assertLess(calls.index("describe_secret"), calls.index("get_secret_value"))

    def test_apply_creates_suppressed_nonadmin_user_and_exact_in_memory_secret(self):
        result = self.invoke(apply=True)
        self.assertEqual(result["status"], "ready")
        writes = self.aws.writes()
        self.assertEqual([name for name, _ in writes],
                         ["admin_create_user", "admin_set_user_password", "put_secret_value"])
        create, permanent, secret = [params for _, params in writes]
        self.assertEqual(create["Username"], EMAIL)
        self.assertEqual(create["MessageAction"], "SUPPRESS")
        self.assertIs(create["ForceAliasCreation"], False)
        self.assertNotIn("ClientMetadata", create)
        self.assertEqual({a["Name"]: a["Value"] for a in create["UserAttributes"]},
                         {"email": EMAIL, "email_verified": "true"})
        self.assertEqual(permanent["Username"], SUB)
        self.assertIs(permanent["Permanent"], True)
        value = json.loads(secret["SecretString"])
        self.assertEqual(set(value), {"email", "password"})
        self.assertEqual(value["email"], EMAIL)
        self.assertEqual(value["password"], permanent["Password"])
        self.assertGreaterEqual(len(value["password"]), 32)
        for chars in ("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789", "!#$%&*+-=?@^_~"):
            self.assertTrue(any(c in chars for c in value["password"]))
        self.assertEqual(secret["SecretId"], SECRET_ARN)
        self.assertEqual(secret["VersionStages"], ["AWSCURRENT"])
        self.assertEqual(self.aws.profile["UserStatus"], "CONFIRMED")
        self.assertFalse(any("add_user_to_group" in n or "update_user" in n for n, _ in self.aws.calls))

    def test_long_pool_password_minimum_is_respected(self):
        self.aws.pool["Policies"]["PasswordPolicy"]["MinimumLength"] = 64
        self.invoke(apply=True)
        self.assertGreaterEqual(len(json.loads(self.aws.secret)["password"]), 64)

    def test_existing_confirmed_pair_never_resets_rotates_or_deletes(self):
        self.aws.existing()
        original = self.aws.secret
        self.assertEqual(self.invoke()["action"], "reuse_existing")
        self.assertEqual(self.invoke(apply=True)["action"], "reuse_existing")
        self.assertEqual(self.aws.secret, original)
        self.assertEqual(self.aws.version, VERSION)
        self.assertEqual(self.aws.writes(), [])

    def test_successful_bootstrap_rerun_is_idempotent(self):
        self.invoke(apply=True)
        original = self.aws.secret
        version = self.aws.version
        self.aws.calls.clear()
        self.assertEqual(self.invoke(apply=True)["action"], "reuse_existing")
        self.assertEqual(self.aws.secret, original)
        self.assertEqual(self.aws.version, version)
        self.assertEqual(self.aws.writes(), [])

    def test_existing_user_without_value_is_never_taken_over(self):
        self.aws.profile = user()
        self.invoke(ok=False)
        self.invoke(apply=True, ok=False)
        self.assertEqual(self.aws.writes(), [])
        self.assertIsNotNone(self.aws.profile)

    def test_existing_secret_absent_user_reuses_password_without_rotating_value(self):
        self.aws.existing()
        self.aws.profile = None
        self.assertEqual(self.invoke()["action"], "create_user_from_value")
        self.assertEqual(self.aws.writes(), [])
        self.invoke(apply=True)
        writes = self.aws.writes()
        self.assertEqual([n for n, _ in writes], ["admin_create_user", "admin_set_user_password"])
        self.assertEqual(writes[1][1]["Password"], PASSWORD)
        self.assertEqual(self.aws.version, VERSION)

    def test_account_pool_secret_identity_mismatches_stop_before_writes(self):
        mutations = [
            lambda: setattr(self.aws, "account", "999999999999"),
            lambda: self.aws.pool.update(Arn=POOL_ARN.replace(ACCOUNT, "999999999999")),
            lambda: self.aws.pool.update(Arn=POOL_ARN.replace(REGION, "us-east-1")),
            lambda: self.aws.pool.update(Id=REGION + "_Other"),
            lambda: self.aws.metadata.update(ARN=SECRET_ARN.replace(ACCOUNT, "999999999999")),
            lambda: self.aws.metadata.update(Name=PROJECT + "/ci/other"),
            lambda: self.aws.metadata.update(DeletedDate=1),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.aws.__init__()
                mutate()
                self.invoke(apply=True, ok=False)
                self.assertEqual(self.aws.writes(), [])

    def test_pool_name_requires_project_suffix_in_plan_and_apply(self):
        for name in (PROJECT, "other-pool"):
            for apply in (False, True):
                with self.subTest(name=name, apply=apply):
                    self.aws.__init__()
                    self.aws.pool["Name"] = name
                    result = self.invoke(apply=apply, ok=False)
                    self.assertEqual(result["error"], "pool_scope_mismatch")
                    self.assertEqual(self.aws.writes(), [])

    def test_invalid_cli_scope_fails_before_sdk_requests(self):
        for flag, value in (("--account", "123"), ("--region", "../region"), ("--project", "bad/project"),
                            ("--user-pool-id", "us-east-1_Other"),
                            ("--secret-arn", SECRET_ARN.replace(REGION, "us-east-1"))):
            args = self.args[:]
            args[args.index(flag) + 1] = value
            with self.subTest(flag=flag):
                self.invoke(args=args, apply=True, ok=False)
        self.assertEqual(self.aws.calls, [])

    def test_denied_or_malformed_secret_never_means_absent(self):
        for raw in ("not json", "null", "{}", '["wrong"]',
                    json.dumps({"email": "somebody@example.test", "password": PASSWORD}),
                    json.dumps({"email": EMAIL, "password": ""}),
                    json.dumps({"email": EMAIL, "password": PASSWORD, "admin": True})):
            with self.subTest(raw=raw):
                self.aws.__init__()
                self.aws.secret = raw
                self.aws.version = VERSION
                self.invoke(apply=True, ok=False)
                self.assertEqual(self.aws.writes(), [])
        for operation in ("describe_secret", "get_secret_value", "admin_get_user"):
            with self.subTest(operation=operation):
                self.aws.__init__()
                self.aws.fail[operation] = denied()
                self.invoke(apply=True, ok=False)
                self.assertEqual(self.aws.writes(), [])

    def test_missing_version_with_known_versions_is_not_empty_metadata(self):
        self.aws.metadata["VersionIdsToStages"] = {VERSION: ["AWSCURRENT"]}
        self.invoke(apply=True, ok=False)
        self.assertEqual(self.aws.writes(), [])

    def test_secret_metadata_disappearing_after_version_error_is_not_absence(self):
        count = 0

        def gone(_):
            nonlocal count
            count += 1
            if count > 1:
                raise SecretNotFound()

        self.aws.fail["describe_secret"] = gone
        self.invoke(apply=True, ok=False)
        self.assertEqual(self.aws.writes(), [])

    def test_existing_disabled_unconfirmed_or_privileged_user_is_preserved(self):
        mutations = [
            lambda: self.aws.profile.update(Enabled=False),
            lambda: self.aws.profile.update(UserStatus="FORCE_CHANGE_PASSWORD"),
            lambda: self.aws.profile.update(UserStatus="EXTERNAL_PROVIDER"),
            lambda: setattr(self.aws, "groups", [{"Groups": [{"GroupName": "admins"}]}]),
            lambda: setattr(self.aws, "groups", [{"Groups": [{"GroupName": "deployment-verifiers",
                                                            "RoleArn": f"arn:aws:iam::{ACCOUNT}:role/privileged"}]}]),
            lambda: self.aws.profile["UserAttributes"][1].update(Value="someone@example.test"),
            lambda: self.aws.profile["UserAttributes"][2].update(Value="false"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.aws.__init__()
                self.aws.existing()
                mutate()
                self.invoke(apply=True, ok=False)
                self.assertEqual(self.aws.writes(), [])
                self.assertIsNotNone(self.aws.profile)

    def test_existing_readiness_group_is_allowed_without_rotation_or_new_grants(self):
        self.aws.existing()
        self.aws.groups = [{"Groups": [{"GroupName": "deployment-verifiers"}]}]
        self.invoke(apply=True)
        self.assertEqual(self.aws.writes(), [])

    def test_new_user_receiving_unexpected_group_privileges_is_not_published(self):
        self.aws.after["admin_create_user"] = lambda: setattr(self.aws, "groups", [
            {"Groups": [{"GroupName": "admins"}]},
        ])
        result = self.invoke(apply=True, ok=False)
        self.assertEqual(result["cleanup"], "deleted_created_user")
        self.assertIsNone(self.aws.profile)
        self.assertIsNone(self.aws.secret)
        self.assertFalse(any(n == "admin_set_user_password" for n, _ in self.aws.calls))

    def test_create_failure_never_deletes_or_resets_a_racing_user(self):
        def race(_):
            self.aws.profile = user(sub=OTHER_SUB)
            raise ClientError({"Error": {"Code": "UsernameExistsException", "Message": PASSWORD}}, "AdminCreateUser")

        self.aws.fail["admin_create_user"] = race
        result = self.invoke(apply=True, ok=False)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual([n for n, _ in self.aws.writes()], ["admin_create_user"])
        self.assertEqual(self.aws.profile["Username"], OTHER_SUB)

    def test_password_or_secret_failure_cleans_up_only_created_sub(self):
        for operation in ("admin_set_user_password", "put_secret_value"):
            with self.subTest(operation=operation):
                self.aws.__init__()
                self.aws.fail[operation] = denied()
                result = self.invoke(apply=True, ok=False)
                self.assertEqual(result["cleanup"], "deleted_created_user")
                self.assertIsNone(self.aws.profile)
                delete_index = next(i for i, (n, _) in enumerate(self.aws.calls) if n == "admin_delete_user")
                self.assertEqual(self.aws.calls[delete_index - 1],
                                 ("admin_get_user", {"UserPoolId": POOL, "Username": SUB}))
                self.assertEqual(self.aws.calls[delete_index][1]["Username"], SUB)

    def test_failure_cleanup_preserves_user_when_sub_recheck_changes_or_is_denied(self):
        for mode in ("changed", "denied"):
            with self.subTest(mode=mode):
                self.aws.__init__()

                def fail(_):
                    if mode == "changed":
                        self.aws.profile = user(sub=OTHER_SUB)
                    else:
                        self.aws.fail["admin_get_user"] = denied()
                    raise denied()

                self.aws.fail["put_secret_value"] = fail
                result = self.invoke(apply=True, ok=False)
                self.assertEqual(result["status"], "incomplete")
                self.assertEqual(result["cleanup"], "preserved")
                self.assertFalse(any(n == "admin_delete_user" for n, _ in self.aws.calls))
                self.assertIsNotNone(self.aws.profile)

    def test_failed_delete_is_reported_incomplete_without_leaking_sdk_message(self):
        self.aws.fail["put_secret_value"] = denied()
        self.aws.fail["admin_delete_user"] = denied()
        result = self.invoke(apply=True, ok=False)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["cleanup"], "preserved")
        self.assertIsNotNone(self.aws.profile)

    def test_missing_create_response_sub_cannot_authorize_cleanup(self):
        def malformed(**kwargs):
            self.aws.called("admin_create_user", kwargs)
            self.aws.profile = user("FORCE_CHANGE_PASSWORD")
            return {"User": {"Username": SUB, "Attributes": [{"Name": "email", "Value": EMAIL}]}}

        with patch.object(self.aws.cognito, "admin_create_user", side_effect=malformed):
            result = self.invoke(apply=True, ok=False)
        self.assertEqual(result["status"], "incomplete")
        self.assertFalse(any(n == "admin_delete_user" for n, _ in self.aws.calls))

    def test_ambiguous_secret_write_failure_can_recover_without_replacing_credential(self):
        def lost_response():
            raise RuntimeError(self.aws.secret)

        self.aws.after["put_secret_value"] = lost_response
        self.invoke(apply=True, ok=False)
        self.assertIsNone(self.aws.profile)
        saved, version = self.aws.secret, self.aws.version
        self.aws.after.clear()
        self.aws.calls.clear()
        self.invoke(apply=True)
        self.assertEqual(self.aws.secret, saved)
        self.assertEqual(self.aws.version, version)
        self.assertFalse(any(n == "put_secret_value" for n, _ in self.aws.calls))

    def test_secret_appearing_during_creation_is_not_overwritten(self):
        def appeared():
            self.aws.secret = json.dumps({"email": EMAIL, "password": PASSWORD})
            self.aws.version = VERSION
            self.aws.metadata["VersionIdsToStages"] = {VERSION: ["AWSCURRENT"]}

        self.aws.after["admin_set_user_password"] = appeared
        self.invoke(apply=True, ok=False)
        self.assertEqual(json.loads(self.aws.secret)["password"], PASSWORD)
        self.assertFalse(any(n == "put_secret_value" for n, _ in self.aws.calls))

    def test_sdk_debug_payloads_and_exception_payloads_are_not_logged(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger("botocore.endpoint")
        old_level = logger.level
        logger.setLevel(logging.DEBUG)
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        self.addCleanup(logger.setLevel, old_level)

        def leak(params):
            logger.debug("payload=%r", params)
            raise RuntimeError(json.dumps(params))

        self.aws.fail["put_secret_value"] = leak
        self.invoke(apply=True, ok=False)
        self.assertEqual(stream.getvalue(), "")

    def test_clients_reuse_region_and_bound_retries_and_network_timeouts(self):
        self.invoke()
        self.assertEqual(self.aws.session_kwargs["region_name"], REGION)
        self.assertEqual(sorted(name for name, _ in self.aws.clients), ["cognito-idp", "secretsmanager", "sts"])
        for _, params in self.aws.clients:
            config = params["config"]
            self.assertLessEqual(config.connect_timeout, 5)
            self.assertLessEqual(config.read_timeout, 10)
            self.assertEqual(config.retries["total_max_attempts"], 1)
            self.assertTrue(config.ignore_configured_endpoint_urls)

    def test_sdk_request_shapes_and_group_paginator_match_installed_models_offline(self):
        self.invoke(apply=True)
        # Local botocore data files only; no clients, credentials or network calls.
        session = get_session()
        operations = {
            "get_caller_identity": ("sts", "GetCallerIdentity"),
            "describe_user_pool": ("cognito-idp", "DescribeUserPool"),
            "admin_get_user": ("cognito-idp", "AdminGetUser"),
            "admin_create_user": ("cognito-idp", "AdminCreateUser"),
            "admin_set_user_password": ("cognito-idp", "AdminSetUserPassword"),
            "admin_list_groups_for_user": ("cognito-idp", "AdminListGroupsForUser"),
            "describe_secret": ("secretsmanager", "DescribeSecret"),
            "get_secret_value": ("secretsmanager", "GetSecretValue"),
            "put_secret_value": ("secretsmanager", "PutSecretValue"),
        }
        for operation, params in self.aws.calls:
            params = copy.deepcopy(params)
            if operation == "admin_list_groups_for_user":
                pagination = session.get_paginator_model("cognito-idp").get_paginator("AdminListGroupsForUser")
                params[pagination["limit_key"]] = params.pop("PaginationConfig")["PageSize"]
            service, name = operations[operation]
            shape = session.get_service_model(service).operation_model(name).input_shape
            result = ParamValidator().validate(params, shape)
            # Never print the validation report: it can contain input values.
            self.assertFalse(result.has_errors(), "SDK request shape mismatch: " + operation)


if __name__ == "__main__":
    unittest.main()
