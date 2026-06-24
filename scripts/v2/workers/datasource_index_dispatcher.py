"""EventBridge-scheduled (daily). Enqueues a `datasource_index` job per enabled Prometheus/Mimir
instance so pre-built diagnostic signals are rebuilt when a datasource's schema changes (version
upgrade) — independent of Explore visits. Mirrors schedule_dispatcher: db.insert_job (ledger) + an
SQS message identical to the BFF's enqueueJob → the existing dispatcher→SFN→Lambda path runs the
`datasource_index` handler. Read-only effect on AWS (the index job reads a cached schema; the
diagnosis egress is separately gated). A per-instance enqueue failure is isolated.
"""
import json
import os
import uuid

import boto3

import db

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))

# v1 scope: Prometheus/Mimir egress-read datasources that are enabled.
_LIST_SQL = (
    "SELECT id, name, kind FROM integrations "
    "WHERE direction='egress' AND capability='read' AND enabled=true "
    "AND kind IN ('prometheus','mimir') ORDER BY id"
)


def _enqueue_index(conn, integration_id):
    job_id = str(uuid.uuid4())
    payload = {"integration_id": integration_id}
    db.insert_job(conn, job_id, "datasource_index", payload)  # durable ledger row
    _sqs.send_message(
        QueueUrl=QUEUE_URL,
        MessageBody=json.dumps({"job_id": job_id, "type": "datasource_index",
                                "payload": payload, "dry_run": False}),
    )
    return job_id


def lambda_handler(_event, _ctx):
    if not QUEUE_URL:
        raise RuntimeError("JOBS_QUEUE_URL is required for datasource_index_dispatcher")  # fail loud
    conn = db.connect()
    try:
        rows = conn.run(_LIST_SQL) or []
        enqueued, failed = 0, 0
        for row in rows:
            iid = row[0]
            try:
                _enqueue_index(conn, iid)
                enqueued += 1
            except Exception as exc:  # noqa: BLE001 — one bad instance must not block the rest
                print(f"datasource_index_dispatcher: enqueue failed for integration {iid}: {exc}")
                failed += 1
        out = {"instances": len(rows), "enqueued": enqueued, "failed": failed}
        print(f"datasource_index_dispatcher: {out}")
        return out
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
