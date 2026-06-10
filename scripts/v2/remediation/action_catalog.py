"""ADR-029+036 — resolve a catalog action by name into an executor binding, and gate it.
Gating layers (ALL must pass before any mutation): (1) REMEDIATION_ENABLED env (the TF flag,
surfaced to the Lambda), (2) the SSM kill-switch /ops/awsops-v2/mutating-actions/enabled == true,
(3) the catalog row's enabled flag. Read-only here; execution lives in remediation_executor.py
and the SSM runbook. Reuses scripts/v2/workers/db.py for the pg8000 connection."""
import json
import os
import boto3
import db  # scripts/v2/workers/db.py (shipped in the same artifact)

_ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_KILL_SWITCH = os.environ.get("MUTATING_ACTIONS_SSM", "/ops/awsops-v2/mutating-actions/enabled")

_COLS = ["name", "executor_type", "target_resource_type", "assume_role_ref",
         "required_inputs", "dry_run_contract", "rollback_ref", "approval_mode",
         "conditions", "enabled"]


def load_action(conn, name):
    rows = conn.run(
        f"SELECT {','.join(_COLS)} FROM action_catalog WHERE name=:n", n=name)
    if not rows:
        return None
    d = dict(zip(_COLS, rows[0]))
    for j in ("required_inputs", "dry_run_contract", "conditions"):
        if isinstance(d[j], str):
            d[j] = json.loads(d[j])
    return d


def flag_enabled():
    # The TF flag is surfaced as an env on every remediation Lambda; default OFF.
    return os.environ.get("REMEDIATION_ENABLED", "false").lower() == "true"


def killswitch_on():
    try:
        return _ssm.get_parameter(Name=_KILL_SWITCH)["Parameter"]["Value"].lower() == "true"
    except Exception:
        return False  # fail-closed: cannot confirm the switch is on → treat as off


def gate(conn, name):
    """Return (action_dict, reason). reason is None iff the action may execute."""
    if not flag_enabled():
        return None, "flag_off"
    if not killswitch_on():
        return None, "killswitch_off"
    a = load_action(conn, name)
    if a is None:
        return None, "unknown_action"
    if not a["enabled"]:
        return None, "action_disabled"
    return a, None
