"""EventBridge-scheduled (daily). Enqueues a single `insight` job so the AI-Insights panel is
periodically refreshed without an Explore/dashboard visit. Mirrors schedule_dispatcher /
datasource_index_dispatcher: db.insert_job (ledger) + an SQS message identical to the BFF's enqueueJob
→ the existing dispatcher→SFN→Lambda path runs the `insight` handler (itself runtime-gated on
AI_INSIGHTS_ENABLED). Read-only effect on AWS. Single-account ('self') → one enqueue per fire.
"""
import json
import os
import uuid

import boto3

import db

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def lambda_handler(_event, _ctx):
    if not QUEUE_URL:
        raise RuntimeError("JOBS_QUEUE_URL is required for insight_dispatcher")  # fail loud
    conn = db.connect()
    try:
        job_id = str(uuid.uuid4())
        payload = {"scheduled": True}
        db.insert_job(conn, job_id, "insight", payload)
        try:
            _sqs.send_message(
                QueueUrl=QUEUE_URL,
                MessageBody=json.dumps({"job_id": job_id, "type": "insight",
                                        "payload": payload, "dry_run": False}),
            )
        except Exception as exc:  # noqa: BLE001 — drop the orphan 'queued' row, don't leave it for the reaper
            print(f"insight_dispatcher: enqueue failed: {exc}")
            try:
                conn.run("DELETE FROM worker_jobs WHERE job_id=:id AND status='queued'", id=job_id)
            except Exception:  # noqa: BLE001
                pass
            return {"enqueued": 0}
        print("insight_dispatcher: enqueued 1")
        return {"enqueued": 1}
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
