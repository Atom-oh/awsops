# scripts/v2/remediation/remediation_executor.py
"""ADR-029+036 — P2 'lambda'/'fargate' code executor for K8s/app-state/composite + observability
actions. Invoked by the remediation SFN's code branch. Input:
  {job_id, plan_id, action, payload, dry_run, phase}  phase ∈ {dry_run, execute, rollback}
Each action: dry_run/execute/rollback. Uses a PER-ACTION task role (NOT the shared worker role) —
the role ARN comes from the env ACTION_ROLE_<ACTION> set by the catalog-pinned Lambda alias, or
is assumed here when the executor runs the shared worker image. Terminal-immutable via db.py."""
import json
import os
import boto3
import db
import action_catalog as cat

_sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _assume(role_arn, session="awsops-remediation"):
    """Assume the per-action role; return a boto3 Session scoped to it (NOT the worker role)."""
    c = _sts.assume_role(RoleArn=role_arn, RoleSessionName=session)["Credentials"]
    return boto3.Session(
        aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
        aws_session_token=c["SessionToken"], region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


# ---- example: app-state feature flag (Aurora row) ----
def _flag_dry_run(payload, _sess):
    return {"would_set": payload.get("flagKey"), "to": payload.get("value"), "mutates": False}

def _flag_execute(conn, payload, _sess):
    prev = conn.run("SELECT config FROM report_schedules WHERE user_sub='__feature_flags__' LIMIT 1") or [[{}]]
    conn.run("UPDATE feature_flags SET value=:v WHERE key=:k", k=payload["flagKey"], v=json.dumps(payload["value"]))
    return {"set": payload["flagKey"], "prev_captured": True}

def _flag_rollback(conn, rollback_plan, _sess):
    conn.run("UPDATE feature_flags SET value=:v WHERE key=:k",
             k=rollback_plan["flagKey"], v=json.dumps(rollback_plan["prev"]))
    return {"rolled_back": rollback_plan["flagKey"]}


# ---- example: observability write (reduced control subset, ADR-036 #5) ----
def _opsitem_dry_run(payload, _sess):
    return {"would_create_opsitem_title": payload.get("title"), "mutates": False}

def _opsitem_execute(_conn, payload, sess):
    ssm = sess.client("ssm")
    r = ssm.create_ops_item(Title=payload["title"], Source=payload["source"],
                            Severity=str(payload.get("severity", "3")), Description=payload.get("title"))
    return {"ops_item_id": r["OpsItemId"]}


_EXEC = {
    "app-feature-flag-set":     {"dry": _flag_dry_run,    "run": _flag_execute,   "rb": _flag_rollback},
    "opscenter-create-opsitem": {"dry": _opsitem_dry_run, "run": _opsitem_execute, "rb": None},
}


def lambda_handler(event, _ctx):
    job_id, action, phase = event["job_id"], event["action"], event.get("phase", "execute")
    payload, dry_run = event.get("payload", {}), bool(event.get("dry_run", False))
    conn = db.connect()
    try:
        a, reason = cat.gate(conn, action)
        if reason:
            # blocked by flag/kill-switch/disabled — record + fail closed (NO mutation)
            raise RuntimeError(f"blocked:{reason}")
        sess = _assume(os.environ[f"ACTION_ROLE_{action.upper().replace('-', '_')}"])
        fns = _EXEC[action]
        if phase == "dry_run" or dry_run:
            return {"job_id": job_id, "phase": "dry_run", "result": fns["dry"](payload, sess)}
        if phase == "rollback":
            if fns["rb"] is None:
                raise RuntimeError("MANUAL_INTERVENTION_REQUIRED: no rollback for action")
            res = fns["rb"](conn, event.get("rollback_plan", {}), sess)
            return {"job_id": job_id, "phase": "rollback", "result": res}
        if db.claim_running(conn, job_id, runtime="lambda") == 0:
            return {"job_id": job_id, "status": "skipped"}  # already terminal (C7)
        res = fns["run"](conn, payload, sess)
        db.finish_job(conn, job_id, "succeeded", result=res)
        return {"job_id": job_id, "status": "succeeded", "result": res}
    finally:
        conn.close()
