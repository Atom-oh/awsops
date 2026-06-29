#!/usr/bin/env python3
"""Steampipe container entrypoint: generate aws.spc from Aurora, then supervise the service.

Reads the enabled accounts + their scan scope from Aurora (account_regions / all_regions), renders
the multi-account/region connection config via spc_render, writes it, then starts `steampipe
service start` as a child process (Python stays alive as the ECS PID-1 supervisor).

Aurora creds arrive as AURORA_SECRET env (task-def `secrets`/valueFrom, execution role) — no
in-container SecretsManager call is needed. AURORA_SECRET is NEVER forwarded to the Steampipe
subprocess; only the Python supervisor holds it, reducing blast radius if the network listener
(Steampipe, port 9193) is compromised (MAJOR 1 mitigation — M1).

On Aurora-unreachable: bounded retry, then fail-closed (exit non-zero) — never start with an
empty/stale config. A background watchdog re-queries Aurora every SCOPE_WATCH_INTERVAL seconds and
restarts Steampipe when account/region scope changes (MAJOR 3 fix — M3).
"""
import json
import os
import signal
import ssl
import subprocess
import sys
import threading
import time

import pg8000.native

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spc_render import render_spc  # noqa: E402

SPC_PATH = os.environ.get("AWS_SPC_PATH", "/home/steampipe/.steampipe/config/aws.spc")
# Scope watchdog interval. Re-querying Aurora every 5 min keeps the hot Steampipe config in sync
# with account/region mutations without requiring a full task replacement. Low enough to catch
# changes within a single sync-lambda cycle; high enough to avoid Aurora connection spam.
SCOPE_WATCH_INTERVAL = int(os.environ.get("SCOPE_WATCH_INTERVAL", "300"))

# Mirrors lib/account-regions.ts listScanScope(): one row per enabled account with its scan scope.
QUERY = (
    "SELECT a.account_id, a.is_host, a.role_name, a.external_id, a.all_regions, "
    "COALESCE(array_agg(r.region ORDER BY r.region) FILTER (WHERE r.enabled), '{}') AS regions "
    "FROM accounts a LEFT JOIN account_regions r ON r.account_id = a.account_id "
    "WHERE a.enabled = true "
    "GROUP BY a.account_id, a.is_host, a.role_name, a.external_id, a.all_regions "
    "ORDER BY a.account_id"
)


def _connect():
    creds = json.loads(os.environ["AURORA_SECRET"])
    # In-VPC TLS: no RDS CA bundle in this image (mirrors sync_lambda._ssl_ctx). The DB password
    # IS transmitted over this connection; CERT_NONE means in-VPC MITM protection relies on VPC
    # network controls, not certificate verification.
    # TODO: add RDS CA bundle to the image and switch to VERIFY_FULL (M2 follow-up).
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


def write_spc(spc: str) -> None:
    os.makedirs(os.path.dirname(SPC_PATH), exist_ok=True)
    with open(SPC_PATH, "w") as f:
        f.write(spc)


def _steampipe_env() -> dict:
    """Environment for the Steampipe subprocess. AURORA_SECRET is intentionally excluded (M1):
    the network-listening Steampipe process must not hold master DB credentials."""
    env = os.environ.copy()
    env.pop("AURORA_SECRET", None)
    return env


def _start_steampipe() -> "subprocess.Popen[bytes]":
    return subprocess.Popen(
        ["steampipe", "service", "start",
         "--database-listen", "network",
         "--database-port", "9193",
         "--foreground"],
        env=_steampipe_env(),
    )


def _scope_watchdog(
    initial_spc: str,
    proc_ref: list,
    proc_lock: threading.Lock,
    stop: threading.Event,
) -> None:
    """Background thread: re-query Aurora every SCOPE_WATCH_INTERVAL seconds. If the rendered
    aws.spc changes (account added/removed/disabled, region scope updated), write the new config
    and restart the Steampipe subprocess (M3)."""
    current = initial_spc
    while not stop.wait(SCOPE_WATCH_INTERVAL):
        try:
            new_spc = render_spc(fetch_rows())
            if new_spc == current:
                continue
            print("[gen-spc] account scope changed — rewriting config and restarting steampipe",
                  file=sys.stderr)
            write_spc(new_spc)
            current = new_spc
            with proc_lock:
                old = proc_ref[0]
                old.terminate()
                try:
                    old.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    old.kill()
                    old.wait()
                proc_ref[0] = _start_steampipe()
            print("[gen-spc] steampipe restarted with updated scope", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"[gen-spc] scope watchdog error (non-fatal): {e}", file=sys.stderr)


def main() -> None:
    # Pre-flight env check: config errors should fail fast with a clear signal, not spend the
    # entire retry budget (~22 s) before reporting "Aurora unreachable" (addresses MINOR-5).
    for var in ("AURORA_SECRET", "AURORA_ENDPOINT", "AURORA_DATABASE"):
        if not os.environ.get(var):
            print(f"[gen-spc] FATAL: required env var '{var}' is not set (config error)",
                  file=sys.stderr)
            sys.exit(1)

    # Bounded retry budget (~2+4+8+8 ≈ 22 s) stays well under the ECS healthcheck startPeriod
    # (120 s) so a transient Aurora delay can't exhaust the grace window and trigger a loop.
    last = None
    rows = None
    attempts = 4
    for attempt in range(1, attempts + 1):
        try:
            rows = fetch_rows()
            break
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"[gen-spc] Aurora unreachable (attempt {attempt}/{attempts}): {e}",
                  file=sys.stderr)
            if attempt < attempts:
                time.sleep(min(2 ** attempt, 8))
    if rows is None:
        print(f"[gen-spc] FATAL: Aurora unreachable after {attempts} attempts — "
              f"failing closed: {last}", file=sys.stderr)
        sys.exit(1)

    spc = render_spc(rows)
    write_spc(spc)
    print(f"[gen-spc] wrote {SPC_PATH} for {len(rows)} enabled account(s)", file=sys.stderr)

    # Start Steampipe (WITHOUT AURORA_SECRET in its env — M1 blast-radius reduction).
    proc_lock = threading.Lock()
    proc_ref = [_start_steampipe()]
    stop = threading.Event()

    # Signal handler: forward ECS SIGTERM/SIGINT to Steampipe, then exit cleanly.
    def _on_signal(signum: int, _frame: object) -> None:
        print(f"[gen-spc] signal {signum} — stopping steampipe and exiting", file=sys.stderr)
        stop.set()
        with proc_lock:
            p = proc_ref[0]
        p.terminate()
        try:
            p.wait(timeout=30)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    # Start scope watchdog (daemon — exits with the supervisor).
    threading.Thread(
        target=_scope_watchdog,
        args=(spc, proc_ref, proc_lock, stop),
        daemon=True,
    ).start()

    # Supervisor loop: wait for the child process and restart on unexpected exit.
    while not stop.is_set():
        with proc_lock:
            current = proc_ref[0]
        code = current.wait()
        if stop.is_set():
            break
        # Watchdog-initiated restarts terminate the old proc; the new proc is already in proc_ref.
        with proc_lock:
            if proc_ref[0] is current:
                # Unexpected exit — restart.
                print(f"[gen-spc] steampipe exited unexpectedly (code {code}) — restarting",
                      file=sys.stderr)
                proc_ref[0] = _start_steampipe()


if __name__ == "__main__":
    main()
