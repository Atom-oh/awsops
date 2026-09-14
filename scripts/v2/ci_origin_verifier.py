#!/usr/bin/env python3
"""One-time operator bootstrap of an unprivileged Cognito smoke-test principal.

Required: --account --region --project --user-pool-id --secret-arn
Default is a read-only plan. --apply explicitly enables creation. The deployment
owner must supply existing governed Secrets Manager metadata; this helper never creates or
changes that resource, groups, policies, app clients or existing users.

The pool Name must exactly equal <project>-pool. The secret name must be
<project>/ci/deployment-verifier. Credentials remain in memory and are written
only to that secret as {"email": "...", "password": "..."}. An existing confirmed,
enabled user with a valid value is reused without resetting either credential.

Run with an operator AWS session, not the CI deployment role. A later authenticated
smoke check verifies login; bootstrap does not authenticate or obtain user tokens.
Serialize operator bootstraps; Cognito creation has no idempotency token. An
ambiguous create result cannot establish ownership for cleanup and is preserved.
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import secrets
import string
import sys
import uuid

import boto3
from botocore.config import Config


SYMBOLS = "!#$%&*+-=?@^_~"
SUB_PATTERN = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"


class BootstrapError(Exception):
    """Static failure codes only; SDK error text and payloads are never reported."""


def require(condition, code):
    if not condition:
        raise BootstrapError(code)


def credential_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "malformed_secret")
            result[key] = value
        return result

    require(isinstance(raw, str) and len(raw) <= 4096, "malformed_secret")
    try:
        value = json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, TypeError):
        raise BootstrapError("malformed_secret") from None
    require(isinstance(value, dict) and set(value) == {"email", "password"}, "malformed_secret")
    return value


class Bootstrap:
    def __init__(self, args):
        require(re.fullmatch(r"[0-9]{12}", args.account), "invalid_account")
        require(re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+", args.region), "invalid_region")
        require(re.fullmatch(r"[a-z][a-z0-9-]{1,48}", args.project), "invalid_project")
        require(re.fullmatch(re.escape(args.region) + r"_[0-9a-zA-Z]+", args.user_pool_id)
                and len(args.user_pool_id) <= 55, "invalid_user_pool_id")
        partition = ("aws-cn" if args.region.startswith("cn-")
                     else "aws-us-gov" if args.region.startswith("us-gov-") else "aws")
        self.secret_name = args.project + "/ci/deployment-verifier"
        secret_prefix = f"arn:{partition}:secretsmanager:{args.region}:{args.account}:secret:{self.secret_name}-"
        require(re.fullmatch(re.escape(secret_prefix) + r"[a-zA-Z0-9]{6}", args.secret_arn), "invalid_secret_arn")
        self.pool_arn = f"arn:{partition}:cognito-idp:{args.region}:{args.account}:userpool/{args.user_pool_id}"
        self.args = args
        self.email = f"ci-deployment-verifier@{args.project}.invalid"
        self.create_attempted = False
        self.created_sub = None
        self.password_policy = {}
        # In particular, do not retry a non-idempotent AdminCreateUser after a
        # lost response. Bounded reads can be rerun by the operator.
        config = Config(connect_timeout=5, read_timeout=10,
                        retries={"total_max_attempts": 1, "mode": "standard"},
                        ignore_configured_endpoint_urls=True)
        session = boto3.Session(region_name=args.region)
        self.sts = session.client("sts", config=config)
        self.cognito = session.client("cognito-idp", config=config)
        self.sm = session.client("secretsmanager", config=config)

    def validate_scope(self):
        require(self.sts.get_caller_identity().get("Account") == self.args.account, "account_mismatch")
        pool = self.cognito.describe_user_pool(UserPoolId=self.args.user_pool_id).get("UserPool", {})
        require(pool.get("Arn") == self.pool_arn and pool.get("Id") == self.args.user_pool_id
                and pool.get("Name") == self.args.project + "-pool", "pool_scope_mismatch")
        # The smoke client supplies only a password. Do not weaken pool MFA to
        # accommodate it or create a principal that requires an unsupported flow.
        require(pool.get("MfaConfiguration") in ("OFF", "OPTIONAL"), "pool_mfa_requires_interaction")
        policy = pool.get("Policies", {}).get("PasswordPolicy", {})
        require(type(policy.get("MinimumLength")) is int and 1 <= policy["MinimumLength"] <= 256,
                "password_policy_invalid")
        self.password_policy = policy

    def secret_metadata(self):
        metadata = self.sm.describe_secret(SecretId=self.args.secret_arn)
        require(metadata.get("ARN") == self.args.secret_arn and metadata.get("Name") == self.secret_name
                and metadata.get("DeletedDate") is None, "secret_scope_mismatch")
        require(isinstance(metadata.get("VersionIdsToStages", {}), dict), "secret_metadata_invalid")
        return metadata

    def valid_password(self, password):
        if (not isinstance(password, str) or not self.password_policy["MinimumLength"] <= len(password) <= 256
                or not password.isprintable() or any(c.isspace() for c in password)):
            return False
        checks = (
            ("RequireUppercase", any(c in string.ascii_uppercase for c in password)),
            ("RequireLowercase", any(c in string.ascii_lowercase for c in password)),
            ("RequireNumbers", any(c in string.digits for c in password)),
            ("RequireSymbols", any(not c.isalnum() for c in password)),
        )
        return all(not self.password_policy.get(flag) or present for flag, present in checks)

    def read_secret(self):
        self.secret_metadata()
        try:
            response = self.sm.get_secret_value(SecretId=self.args.secret_arn, VersionStage="AWSCURRENT")
        except self.sm.exceptions.ResourceNotFoundException:
            # The same error can mean the secret itself disappeared. Confirm the
            # exact metadata again; only a resource with no versions is empty.
            metadata = self.secret_metadata()
            require(not metadata.get("VersionIdsToStages"), "secret_version_unavailable")
            return None
        require(response.get("ARN") == self.args.secret_arn and response.get("Name") == self.secret_name
                and isinstance(response.get("VersionId"), str) and response["VersionId"]
                and isinstance(response.get("VersionStages"), list)
                and "AWSCURRENT" in response["VersionStages"] and "SecretBinary" not in response,
                "secret_value_scope_mismatch")
        value = credential_json(response.get("SecretString"))
        require(value["email"] == self.email and self.valid_password(value["password"]), "malformed_secret")
        return value

    def get_user(self, identifier=None):
        try:
            return self.cognito.admin_get_user(UserPoolId=self.args.user_pool_id,
                                               Username=identifier or self.email)
        except self.cognito.exceptions.UserNotFoundException:
            return None

    def identity(self, profile, *, ready):
        require(isinstance(profile, dict), "user_identity_invalid")
        attributes = profile.get("UserAttributes", profile.get("Attributes"))
        require(isinstance(attributes, list), "user_identity_invalid")
        values = {}
        for attribute in attributes:
            name, value = attribute.get("Name"), attribute.get("Value")
            require(isinstance(name, str) and isinstance(value, str) and name not in values,
                    "user_identity_invalid")
            values[name] = value
        sub = values.get("sub")
        require(isinstance(sub, str) and re.fullmatch(SUB_PATTERN, sub)
                and values.get("email") == self.email and values.get("email_verified") == "true",
                "user_identity_mismatch")
        username = profile.get("Username")
        # Email-sign-in pools generate an internal UUID username. The requested
        # sign-in identifier remains deterministic; mutations target immutable sub.
        require(isinstance(username, str) and (username == self.email or re.fullmatch(SUB_PATTERN, username)),
                "user_identity_mismatch")
        require(not any(name.startswith("custom:") for name in values), "unexpected_user_attributes")
        require(profile.get("Enabled") is True, "user_disabled")
        if ready:
            require(profile.get("UserStatus") == "CONFIRMED", "user_not_confirmed")
            require(not profile.get("UserMFASettingList") and not profile.get("MFAOptions"),
                    "user_mfa_requires_interaction")
        return sub

    def safe_groups(self, sub):
        paginator = self.cognito.get_paginator("admin_list_groups_for_user")
        seen = 0
        for page in paginator.paginate(UserPoolId=self.args.user_pool_id, Username=sub,
                                       PaginationConfig={"PageSize": 60}):
            seen += 1
            require(seen <= 5, "group_check_incomplete")
            require(isinstance(page.get("Groups"), list), "group_check_incomplete")
            require(all(isinstance(group, dict) and group.get("GroupName") == "deployment-verifiers"
                        and not group.get("RoleArn") for group in page["Groups"]),
                    "user_has_group_privileges")
        require(seen > 0, "group_check_incomplete")

    def check_created(self, *, ready):
        sub = self.identity(self.get_user(self.created_sub), ready=ready)
        require(sub == self.created_sub, "created_user_identity_changed")
        self.safe_groups(sub)

    def generate_password(self):
        groups = (string.ascii_lowercase, string.ascii_uppercase, string.digits, SYMBOLS)
        chars = [secrets.choice(group) for group in groups]
        alphabet = "".join(groups)
        chars.extend(secrets.choice(alphabet) for _ in range(max(32, self.password_policy["MinimumLength"]) - 4))
        secrets.SystemRandom().shuffle(chars)
        return "".join(chars)

    def run(self):
        self.validate_scope()
        stored = self.read_secret()
        profile = self.get_user()
        if profile is not None:
            sub = self.identity(profile, ready=True)
            self.safe_groups(sub)
            require(stored is not None, "existing_user_without_secret")
            return "reuse_existing"

        action = "create_user_from_value" if stored is not None else "create_user_and_value"
        if not self.args.apply:
            return action
        # Recheck absence before creating, but never claim a racing user if
        # AdminCreateUser fails or returns no usable immutable identity.
        require(self.get_user() is None, "user_appeared")
        password = stored["password"] if stored is not None else self.generate_password()
        self.create_attempted = True
        response = self.cognito.admin_create_user(
            UserPoolId=self.args.user_pool_id, Username=self.email, MessageAction="SUPPRESS",
            ForceAliasCreation=False, TemporaryPassword=password,
            UserAttributes=[{"Name": "email", "Value": self.email}, {"Name": "email_verified", "Value": "true"}],
        )
        self.created_sub = self.identity(response.get("User"), ready=False)
        self.check_created(ready=False)
        self.cognito.admin_set_user_password(UserPoolId=self.args.user_pool_id, Username=self.created_sub,
                                             Password=password, Permanent=True)
        self.check_created(ready=True)

        # Do not overwrite a value that another operator published while Cognito
        # creation was in flight. Existing values are always retained verbatim.
        require(self.read_secret() == stored, "secret_changed")
        expected = {"email": self.email, "password": password}
        if stored is None:
            token = str(uuid.uuid4())
            result = self.sm.put_secret_value(SecretId=self.args.secret_arn, ClientRequestToken=token,
                                              SecretString=json.dumps(expected, separators=(",", ":")),
                                              VersionStages=["AWSCURRENT"])
            require(result.get("ARN") == self.args.secret_arn and result.get("Name") == self.secret_name
                    and result.get("VersionId") == token and "AWSCURRENT" in result.get("VersionStages", []),
                    "secret_write_unconfirmed")
        require(self.read_secret() == expected, "secret_readback_mismatch")
        self.check_created(ready=True)
        return action

    def cleanup_created(self):
        if self.created_sub is None:
            return "preserved"
        try:
            current = self.get_user(self.created_sub)
            if current is None:
                return "already_absent"
            require(self.identity(current, ready=False) == self.created_sub, "cleanup_identity_changed")
            # Use sub, never the reusable email alias; delete only after a fresh
            # read proves it still identifies the principal created by this run.
            self.cognito.admin_delete_user(UserPoolId=self.args.user_pool_id, Username=self.created_sub)
            return "deleted_created_user"
        except Exception:
            return "preserved"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("account", "region", "project", "user-pool-id", "secret-arn"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--apply", action="store_true", help="Create the missing service principal/value; default is plan")
    args = parser.parse_args(argv)
    bootstrap = None
    previous_logging_disable = logging.root.manager.disable
    # Even an embedding caller's DEBUG wire logger must not emit SDK password
    # payloads. Restore logging on return; summaries use print, not SDK logging.
    logging.disable(logging.CRITICAL)
    try:
        bootstrap = Bootstrap(args)
        action = bootstrap.run()
        print(json.dumps({"mode": "apply" if args.apply else "plan",
                          "status": "ready" if args.apply else "planned", "action": action,
                          "username": bootstrap.email}, sort_keys=True))
        return 0
    except Exception as error:
        attempted = bootstrap is not None and bootstrap.create_attempted
        cleanup = bootstrap.cleanup_created() if attempted else "not_needed"
        code = str(error) if isinstance(error, BootstrapError) else "sdk_operation_failed"
        if not re.fullmatch(r"[a-z_]+", code):
            code = "bootstrap_failed"
        print(json.dumps({"mode": "apply" if args.apply else "plan",
                          "status": "incomplete" if attempted else "failed", "error": code,
                          "cleanup": cleanup}, sort_keys=True))
        return 1
    finally:
        logging.disable(previous_logging_disable)


if __name__ == "__main__":
    sys.exit(main())
