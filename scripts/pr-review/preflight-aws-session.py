#!/usr/bin/env python3
"""Check the ambient Pod Identity provider without exporting credentials."""
import json
import os
import subprocess
import sys


def preflight():
    env = os.environ.copy()
    if not all(env.get(key) for key in (
        "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    )):
        raise ValueError("runner Pod Identity credential source is unavailable")
    # Preserve credential-chain, profile and signing settings. Changing them only here
    # could validate a different identity from the one the model CLIs actually use.
    env.update(AWS_CLI_AUTO_PROMPT="off", AWS_PAGER="")
    result = subprocess.run(
        ["aws", "configure", "list"], env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, check=True, timeout=45,
    )
    # `configure list` masks key values and identifies the selected provider. Support
    # the colon-delimited table and older whitespace-delimited AWS CLI versions.
    providers = {}
    for line in result.stdout.splitlines():
        fields = [field.strip() for field in line.split(":", 3)] if ":" in line else line.split()
        if fields and fields[0] in ("access_key", "secret_key"):
            if len(fields) < 3 or fields[0] in providers:
                raise ValueError("invalid provider metadata")
            providers[fields[0]] = fields[2]
    if providers != {"access_key": "container-role", "secret_key": "container-role"}:
        raise ValueError("ambient provider is not the existing Pod Identity provider")

    # A signed, read-only call checks current validity (including expiry). A cached
    # lease may be valid with little time remaining; each CLI keeps its ambient SDK
    # refresh path. This neither requests a new lease nor guarantees a phase-long TTL.
    result = subprocess.run(
        ["aws", "sts", "get-caller-identity", "--output", "json"],
        env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, check=True, timeout=45,
    )
    identity = json.loads(result.stdout)
    if not isinstance(identity, dict) or not all(
        isinstance(identity.get(key), str) and identity[key].strip()
        for key in ("Account", "Arn", "UserId")
    ):
        raise ValueError("invalid caller identity")


def main():
    try:
        preflight()
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        # CLI errors can contain credentials; keep diagnostics independent of provider output.
        print(f"::error::AWS session preflight failed ({type(error).__name__}); refusing model phase.",
              file=sys.stderr)
        return 1
    print("Existing runner Pod Identity preflight passed; SDK credential provider unchanged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
