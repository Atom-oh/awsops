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


def handler(event, context):
    cluster = os.environ["CLUSTER"]
    services = [s for s in os.environ.get("SERVICES", "").split(",") if s]
    ecs = boto3.client("ecs")
    redeployed = []
    for svc in services:
        ecs.update_service(cluster=cluster, service=svc, forceNewDeployment=True)
        redeployed.append(svc)
    print(f"[secret-rotation-redeploy] forced new deployment on: {redeployed} "
          f"(trigger: {event.get('detail', {}).get('eventName')})")
    return {"redeployed": redeployed}
