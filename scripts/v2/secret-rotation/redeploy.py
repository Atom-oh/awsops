"""Force a new ECS deployment when the Aurora master secret rotates.

Triggered by an EventBridge rule on the Secrets Manager `RotationSucceeded` event for the Aurora
master secret. Long-running services (e.g. the web BFF) inject the DB password via ECS
`secrets`/valueFrom at TASK START, so after a rotation the running task keeps the pre-rotation
password and Aurora auth fails (`password authentication failed`). force-new-deployment makes ECS
start fresh tasks that re-read the rotated secret. Read-only toward AWS resources except this
rolling restart of the named services.
"""
import os

import boto3


def _event_secret_id(event):
    """The rotated secret's id/ARN — the field path varies across event shapes, so try each."""
    d = event.get("detail", {}) or {}
    for path in (("additionalEventData", "SecretId"), ("serviceEventDetails", "secretId"), ("requestParameters", "secretId")):
        v = d
        for k in path:
            v = v.get(k) if isinstance(v, dict) else None
        if v:
            return str(v)
    return None


def handler(event, context):
    cluster = os.environ["CLUSTER"]
    services = [s for s in os.environ.get("SERVICES", "").split(",") if s]
    want = os.environ.get("AURORA_SECRET_ARN", "")
    got = _event_secret_id(event)
    # FAIL-CLOSED: the rule matches RotationSucceeded broadly (across accounts/secrets), so redeploy
    # ONLY when we positively confirm this is the Aurora master secret. The Aurora RDS-managed
    # rotation event carries the id in additionalEventData.SecretId; if we can't identify the secret,
    # or it isn't ours, SKIP (never restart prod web on an unrelated secret's rotation). A WARN log
    # surfaces the unparsed shape so the field path can be corrected.
    if not got:
        import sys
        print(f"[secret-rotation-redeploy] WARN: rotated secret id not found in event detail keys "
              f"{list((event.get('detail') or {}).keys())} — SKIPPING (fail-closed)", file=sys.stderr)
        return {"skipped": "unidentified-secret"}
    if want and got not in want and want not in got:
        print(f"[secret-rotation-redeploy] ignoring rotation of {got} (not the Aurora master secret)")
        return {"skipped": got}
    ecs = boto3.client("ecs")
    redeployed = []
    for svc in services:
        ecs.update_service(cluster=cluster, service=svc, forceNewDeployment=True)
        redeployed.append(svc)
    print(f"[secret-rotation-redeploy] forced new deployment on: {redeployed} "
          f"(trigger: {event.get('detail', {}).get('eventName')})")
    return {"redeployed": redeployed}
