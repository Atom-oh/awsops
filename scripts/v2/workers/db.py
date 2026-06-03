"""AWSops v2 P2 — shared Aurora access (pg8000) + worker_jobs CRUD.

Env: AURORA_ENDPOINT, AURORA_DATABASE, AURORA_SECRET_ARN (RDS-managed master secret), AWS_REGION.
Transitions are CONDITIONAL: terminal states (succeeded/failed/canceled) are immutable, so an SFN
Catch cannot overwrite a worker's succeeded, and retries cannot resurrect a done job.
"""
import json
import os
import ssl
import boto3
import pg8000.native

_TERMINAL = ("succeeded", "failed", "canceled")
_secret_cache = {}


def _creds():
    arn = os.environ["AURORA_SECRET_ARN"]
    if arn not in _secret_cache:
        sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
        _secret_cache[arn] = json.loads(sm.get_secret_value(SecretId=arn)["SecretString"])
    return _secret_cache[arn]


def _ssl_ctx():
    # Match the web's pg ssl: rejectUnauthorized:false (no RDS CA bundling in dev). Prod: bundle RDS CA.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def connect():
    c = _creds()
    return pg8000.native.Connection(
        user=c["username"], password=c["password"],
        host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
        port=5432, ssl_context=_ssl_ctx(),
    )


def insert_job(conn, job_id, type_, payload, dry_run=False, idempotency_key=None):
    conn.run(
        "INSERT INTO worker_jobs (job_id, type, payload, dry_run, idempotency_key) "
        "VALUES (:id, :t, :p::jsonb, :d, :k)",
        id=job_id, t=type_, p=json.dumps(payload), d=dry_run, k=idempotency_key,
    )


def claim_running(conn, job_id, runtime):
    """queued|running -> running (idempotent re-claim). Returns rows affected (0 = already terminal)."""
    rows = conn.run(
        "UPDATE worker_jobs SET status='running', runtime=:r, attempt=attempt+1 "
        "WHERE job_id=:id AND status NOT IN ('succeeded','failed','canceled') RETURNING job_id",
        id=job_id, r=runtime,
    )
    return len(rows)


def finish_job(conn, job_id, status, result=None, artifact_uri=None, error=None):
    """Set a TERMINAL status only if not already terminal (immutable). Returns rows affected."""
    assert status in _TERMINAL
    rows = conn.run(
        "UPDATE worker_jobs SET status=:s, result=:res::jsonb, artifact_uri=:a, error=:e "
        "WHERE job_id=:id AND status NOT IN ('succeeded','failed','canceled') RETURNING job_id",
        s=status, res=(json.dumps(result) if result is not None else None),
        a=artifact_uri, e=error, id=job_id,
    )
    return len(rows)


# Single source of truth for get_job's SELECT + dict keys (avoids positional-zip drift).
_JOB_COLS = ["job_id", "type", "status", "payload", "result", "artifact_uri", "error", "dry_run"]


def get_job(conn, job_id):
    rows = conn.run(f"SELECT {','.join(_JOB_COLS)} FROM worker_jobs WHERE job_id=:id", id=job_id)
    return dict(zip(_JOB_COLS, rows[0])) if rows else None
