#!/usr/bin/env python3
"""Steampipe container entrypoint: generate aws.spc from Aurora at boot, then exec the service.

Reads the enabled accounts + their scan scope from Aurora (account_regions / all_regions), renders
the multi-account/region connection config via spc_render, writes it, then execs `steampipe service
start`. Aurora creds arrive as the AURORA_SECRET env (task-def `secrets`/valueFrom, execution role)
so no in-container SecretsManager call is needed. On Aurora-unreachable: bounded retry, then
fail-closed (exit non-zero) — never start with an empty/stale config.
"""
import json
import os
import ssl
import sys
import time

import pg8000.native

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spc_render import render_spc  # noqa: E402

SPC_PATH = os.environ.get("AWS_SPC_PATH", "/home/steampipe/.steampipe/config/aws.spc")

# Mirrors lib/account-regions.ts listScanScope(): one row per enabled account with its scan scope.
QUERY = (
    "SELECT a.account_id, a.is_host, a.role_name, a.external_id, a.all_regions, "
    "COALESCE(array_agg(r.region) FILTER (WHERE r.enabled), '{}') AS regions "
    "FROM accounts a LEFT JOIN account_regions r ON r.account_id = a.account_id "
    "WHERE a.enabled = true "
    "GROUP BY a.account_id, a.is_host, a.role_name, a.external_id, a.all_regions "
    "ORDER BY a.account_id"
)


def _connect():
    creds = json.loads(os.environ["AURORA_SECRET"])
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return pg8000.native.Connection(
        user=creds["username"], password=creds["password"],
        host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
        port=5432, ssl_context=ctx,
    )


def fetch_rows():
    conn = _connect()
    try:
        rows = conn.run(QUERY)
        cols = [c["name"] for c in conn.columns]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        conn.close()


def main():
    # Bounded retry budget (~2+4+8+8 ≈ 22s) is kept WELL under the ECS healthcheck startPeriod
    # (120s) so a transient Aurora delay can't exhaust the grace window and trigger a restart loop
    # (M5). No sleep after the final attempt.
    last = None
    attempts = 4
    rows = None
    for attempt in range(1, attempts + 1):
        try:
            rows = fetch_rows()
            break
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"[gen-spc] Aurora unreachable (attempt {attempt}/{attempts}): {e}", file=sys.stderr)
            if attempt < attempts:
                time.sleep(min(2 ** attempt, 8))
    if rows is None:
        print(f"[gen-spc] FATAL: Aurora unreachable — failing closed: {last}", file=sys.stderr)
        sys.exit(1)

    spc = render_spc(rows)
    os.makedirs(os.path.dirname(SPC_PATH), exist_ok=True)
    with open(SPC_PATH, "w") as f:
        f.write(spc)
    print(f"[gen-spc] wrote {SPC_PATH} for {len(rows)} enabled account(s)", file=sys.stderr)

    os.execvp("steampipe", [
        "steampipe", "service", "start",
        "--database-listen", "network", "--database-port", "9193", "--foreground",
    ])


if __name__ == "__main__":
    main()
