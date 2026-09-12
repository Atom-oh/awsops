#!/usr/bin/env python3
"""Resolve the existing runner Pod Identity session before each model phase."""
from datetime import datetime, timezone
import json
import os
import re
import subprocess
import sys


def main():
    env = os.environ.copy()
    if not env.get("AWS_CONTAINER_CREDENTIALS_FULL_URI"):
        raise ValueError("runner Pod Identity credential source is unavailable")
    # Do not re-export stale static keys from the runner or the previous model phase.
    # Resolve ONLY its existing Pod Identity provider; no new role, self-assume, or IAM change.
    for key in (
        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
        "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    ):
        env.pop(key, None)
    env.update(
        AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null",
        BOTO_CONFIG="/dev/null", AWS_EC2_METADATA_DISABLED="true",
        AWS_CLI_AUTO_PROMPT="off", AWS_PAGER="",
    )
    result = subprocess.run(
        ["aws", "configure", "export-credentials", "--format", "process"],
        env=env, capture_output=True, text=True, check=True, timeout=45,
    )
    credentials = json.loads(result.stdout)
    expiry = datetime.fromisoformat(credentials["Expiration"].replace("Z", "+00:00"))
    remaining = (expiry - datetime.now(timezone.utc)).total_seconds()
    # Pod Identity can return a cached session. Never mistake it for a fresh full lease.
    minimum = int(os.environ.get("AWS_SESSION_MIN_TTL", "2700"))
    if remaining < minimum:
        raise ValueError(f"existing Pod Identity session has less than {minimum}s remaining")
    exports = {
        "AWS_ACCESS_KEY_ID": credentials["AccessKeyId"],
        "AWS_SECRET_ACCESS_KEY": credentials["SecretAccessKey"],
        "AWS_SESSION_TOKEN": credentials["SessionToken"],
    }
    if not all(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9/+=]+", value)
               for value in exports.values()):
        raise ValueError("invalid session credential fields")
    # Mask before exporting; never log raw provider stdout/stderr or write a credential artifact.
    for value in exports.values():
        print(f"::add-mask::{value}", flush=True)
    with open(os.environ["GITHUB_ENV"], "a") as target:
        for key, value in exports.items():
            target.write(f"{key}={value}\n")
    print(f"Existing runner AWS session refreshed ({int(remaining)}s remaining).")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        # CLI errors can contain credentials; keep diagnostics independent of provider output.
        print(f"::error::AWS session refresh failed ({type(error).__name__}); refusing model phase.",
              file=sys.stderr)
        sys.exit(1)
