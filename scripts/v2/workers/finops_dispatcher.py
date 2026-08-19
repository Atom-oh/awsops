"""EventBridge-scheduled (daily). Enqueues ONE `finops_baseline` job (ADR-019) — unlike
datasource_index_dispatcher/schedule_dispatcher there is no per-row fan-out; the rule engine itself
iterates the catalog against the whole account in a single run.

Idempotent against double-fire (EventBridge occasionally retries): idempotency_key is the UTC date,
and worker_jobs has no unique constraint on it today — so this dispatcher enforces "already enqueued
today" itself via a pre-check, rather than relying on a DB constraint to reject the duplicate insert.
Mirrors schedule_dispatcher/datasource_index_dispatcher: db.insert_job (ledger) + an SQS message
identical to the BFF's enqueueJob -> the existing dispatcher->SFN->Fargate path runs the job.
Read-only effect on AWS (the job itself only reads CE/Compute Optimizer/Cost Optimization Hub/
inventory_resources)."""
import json
import os
import uuid
from datetime import datetime, timezone

import boto3

import db

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _already_enqueued_today(conn, key):
    rows = conn.run(
        "SELECT 1 FROM worker_jobs WHERE type='finops_baseline' AND idempotency_key=:k LIMIT 1", k=key
    )
    return bool(rows)


def lambda_handler(_event, _ctx):
    if not QUEUE_URL:
        raise RuntimeError("JOBS_QUEUE_URL is required for finops_dispatcher")  # fail loud
    key = f"finops_baseline:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    conn = db.connect()
    try:
        if _already_enqueued_today(conn, key):
            print(f"finops_dispatcher: already enqueued today ({key}), skipping")
            return {"enqueued": False, "reason": "already_enqueued_today"}
        job_id = str(uuid.uuid4())
        payload = {}
        db.insert_job(conn, job_id, "finops_baseline", payload, idempotency_key=key)
        try:
            _sqs.send_message(
                QueueUrl=QUEUE_URL,
                MessageBody=json.dumps({"job_id": job_id, "type": "finops_baseline",
                                        "payload": payload, "dry_run": False}),
            )
        except Exception:
            try:
                conn.run("DELETE FROM worker_jobs WHERE job_id=:id AND status='queued'", id=job_id)
            except Exception:  # noqa: BLE001
                pass
            raise
        print(f"finops_dispatcher: enqueued job_id={job_id}")
        return {"enqueued": True, "job_id": job_id}
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
