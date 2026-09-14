#!/usr/bin/env python3
"""Private-file preparation for production Actions; never export application secrets."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import urlsplit


class PreparationError(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise PreparationError(code)


def validate(env):
    require(not any(key.startswith("AWS_ENDPOINT_URL") and value for key, value in env.items()),
            "aws_endpoint_override")
    account = env.get("CI_EXPECTED_ACCOUNT_ID", "")
    project = env.get("CI_EXPECTED_PROJECT", "")
    region = env.get("AWS_REGION", "")
    require(re.fullmatch(r"\d{12}", account), "invalid_account")
    require(re.fullmatch(r"[a-z][a-z0-9-]{1,39}", project), "invalid_project")
    require(re.fullmatch(r"(af|ap|ca|eu|il|me|mx|sa|us)-(central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*", region),
            "invalid_region")
    require(env.get("CI_ROLE_ARN") == f"arn:aws:iam::{account}:role/{project}-ci-release",
            "unexpected_release_role")
    prefix = f"arn:aws:secretsmanager:{region}:{account}:secret:{project}/ci/deployment-verifier-"
    require(re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9]{6}", env.get("CI_SMOKE_SECRET_ARN", "")),
            "unexpected_smoke_secret")
    reader = env.get("CI_SQL_READER_SECRET_ARN", "")
    reader_prefix = f"arn:aws:secretsmanager:{region}:{account}:secret:ops/{project}/agent/sql-reader-"
    require(reader == "disabled" or re.fullmatch(re.escape(reader_prefix) + r"[A-Za-z0-9]{6}", reader),
            "sql_reader_declaration_required")
    url = urlsplit(env.get("CI_EXPECTED_URL", ""))
    require(url.scheme == "https" and url.hostname and not url.username and not url.password
            and url.port in {None, 443} and url.path in {"", "/"} and not url.query and not url.fragment,
            "invalid_service_origin")
    require(re.fullmatch(r"\d+", env.get("GITHUB_RUN_ID", ""))
            and re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ATTEMPT", "")), "invalid_run_identity")
    return account, project, region


def work_dir(env):
    require(re.fullmatch(r"\d+", env.get("GITHUB_RUN_ID", ""))
            and re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ATTEMPT", "")), "invalid_run_identity")
    runner_temp = env.get("RUNNER_TEMP", "")
    require(runner_temp and "\n" not in runner_temp and "\r" not in runner_temp, "invalid_runner_temp")
    root = Path(runner_temp).resolve()
    require(root.is_dir(), "runner_temp_missing")
    path = root / f"awsops-release-{env['GITHUB_RUN_ID']}-{env['GITHUB_RUN_ATTEMPT']}"
    require(not path.is_symlink(), "private_directory_symlink")
    return path


def private_write(path, text):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
    except OSError:
        raise PreparationError("private_file_creation_failed") from None


def prepare(env):
    validate(env)
    path = work_dir(env)
    try:
        path.mkdir(mode=0o700)
    except OSError:
        raise PreparationError("private_directory_already_exists") from None
    private_write(path / ".owner", f"{env['GITHUB_RUN_ID']}:{env['GITHUB_RUN_ATTEMPT']}")
    result = {
        "CI_WORK_DIR": str(path),
        "CI_RELEASE_MANIFEST": str(path / "release.json"),
        "CI_SMOKE_CREDENTIAL_FILE": str(path / "smoke.json"),
        "CI_MIGRATION_RECEIPT": str(path / "migration.json"),
    }
    require(env.get("GITHUB_ENV"), "github_env_missing")
    with open(env["GITHUB_ENV"], "a") as stream:
        for key, value in result.items():
            require("\n" not in value and "\r" not in value, "invalid_private_path")
            stream.write(f"{key}={value}\n")
    return result


def fetch_smoke_secret(env, aws):
    _, _, region = validate(env)
    path = work_dir(env)
    expected = path / "smoke.json"
    require(env.get("CI_SMOKE_CREDENTIAL_FILE") == str(expected), "unexpected_credential_path")
    require(path.is_dir() and stat.S_IMODE(path.stat().st_mode) == 0o700, "private_directory_invalid")
    response = aws(["secretsmanager", "get-secret-value", "--region", region,
                    "--secret-id", env["CI_SMOKE_SECRET_ARN"], "--output", "json"])
    try:
        value = json.loads(response["SecretString"])
    except (KeyError, TypeError, json.JSONDecodeError):
        raise PreparationError("invalid_smoke_secret") from None
    require(isinstance(value, dict) and set(value) == {"email", "password"}
            and isinstance(value["email"], str) and 0 < len(value["email"]) <= 254
            and isinstance(value["password"], str) and 0 < len(value["password"]) <= 256,
            "invalid_smoke_secret")
    private_write(expected, json.dumps(value))


def verify_caller(env, aws):
    account, project, region = validate(env)
    caller = aws(["sts", "get-caller-identity", "--region", region, "--output", "json"])
    require(caller.get("Account") == account
            and str(caller.get("Arn", "")).startswith(
                f"arn:aws:sts::{account}:assumed-role/{project}-ci-release/"),
            "unexpected_aws_caller")


def cleanup(env):
    path = work_dir(env)
    if not path.exists():
        return
    marker = path / ".owner"
    require(not marker.is_symlink() and marker.is_file()
            and marker.read_text() == f"{env['GITHUB_RUN_ID']}:{env['GITHUB_RUN_ATTEMPT']}",
            "cleanup_owner_mismatch")
    shutil.rmtree(path)


def aws_json(args):
    try:
        proc = subprocess.run(["aws", *args], check=True, capture_output=True, text=True, timeout=60)
        return json.loads(proc.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError):
        raise PreparationError("secret_retrieval_failed") from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("prepare", "verify-caller", "fetch-smoke-secret", "cleanup"))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.operation == "prepare":
            prepare(os.environ)
        elif args.operation == "verify-caller":
            verify_caller(os.environ, aws_json)
        elif args.operation == "fetch-smoke-secret":
            fetch_smoke_secret(os.environ, aws_json)
        else:
            cleanup(os.environ)
        print(json.dumps({"operation": args.operation, "status": "ok"}))
    except (PreparationError, OSError, ValueError):
        print(json.dumps({"operation": args.operation, "status": "error",
                          "code": "private_configuration_failed"}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
