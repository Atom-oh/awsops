"""AWSops v2 P2 — job-type registry. READ/COMPUTE only (no mutate ops until P3 ADR-029 controls).
Each handler: (payload: dict, dry_run: bool) -> (result_dict_or_None, artifact_bytes_or_None).
P2 ships ONE synthetic proof handler ('noop') exercising sleep / memory / optional OOM."""
import os
import time


def _noop(payload, dry_run):
    secs = int(payload.get("sleep_s", 0))
    mb = int(payload.get("alloc_mb", 0))
    if dry_run:
        return {"dry_run": True, "would_sleep_s": secs, "would_alloc_mb": mb}, None
    if secs:
        time.sleep(secs)
    blob = bytearray(mb * 1024 * 1024) if mb else None
    out = {"slept_s": secs, "alloc_mb": mb, "ok": True}
    del blob
    return out, None


def _upload_markdown(md, report_id):
    """[GATE-FIX CRITICAL] The shared worker runners DISCARD the artifact return value
    (worker_lambda.py / fargate_worker.py do `result, _artifact = fn(...)` and drop it; there
    is NO put_object in the worker tier). So _report uploads to S3 itself and returns the URI."""
    import boto3
    bucket = os.environ.get("ARTIFACT_BUCKET")
    if not bucket:
        raise RuntimeError("ARTIFACT_BUCKET not set")
    key = f"diagnosis/{report_id}.md"
    boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-northeast-2")).put_object(
        Bucket=bucket, Key=key, Body=md.encode("utf-8"), ContentType="text/markdown")
    return f"s3://{bucket}/{key}"


def _report(payload, dry_run):
    """AI Diagnosis report. payload: {account, tier, requested_by, report_id}.
    The BFF creates the diagnosis_reports row (running) and passes report_id — this fixes the
    worker_job_id FK (handlers receive only `payload`, never job_id) and the UI race. _report
    uploads the markdown to S3 itself and writes artifact_uri. Read-only AWS data sources."""
    account = str(payload.get("account", ""))
    tier = payload.get("tier", "mid")
    requested_by = payload.get("requested_by", "unknown")
    report_id = payload.get("report_id")
    if dry_run:
        return {"dry_run": True, "would_diagnose": account, "tier": tier}, None
    import db as wdb
    from diagnosis import db as ddb
    from diagnosis import report as rpt
    import traceback
    conn = wdb.connect()
    try:  # [PR#37 review CRITICAL] always release the pg8000 connection (was leaked every call → Aurora pool exhaustion under retries)
        # Fallback: if BFF didn't pre-create (older enqueue), create now (worker_job_id stays NULL).
        if not report_id:
            report_id = ddb.create_report(conn, worker_job_id=None, tier=tier, requested_by=requested_by)
        try:
            md, summary, sources_used = rpt.generate(conn, account, tier)
            artifact_uri = _upload_markdown(md, report_id)
            status = "partial" if summary.get("degraded") else "succeeded"
            ddb.finish_report(conn, report_id, status=status, sources_used=sources_used,
                              summary=summary, artifact_uri=artifact_uri)
            return {"report_id": report_id, "status": status, "artifact_uri": artifact_uri}, md.encode("utf-8")
        except Exception as e:  # noqa: BLE001
            print(traceback.format_exc())  # full trace → CloudWatch logs only
            # [review MINOR] str(e) to the DB (the error field reaches the client via /api/diagnosis/[id])
            ddb.finish_report(conn, report_id, status="failed", error=str(e))
            raise
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


# type -> (handler, runtime). runtime drives SFN routing (lambda<15min / fargate long+heavy).
REGISTRY = {
    "noop":       (_noop, "lambda"),
    "noop-heavy": (_noop, "fargate"),
    "report":     (_report, "fargate"),
}


def is_allowed(type_):
    return type_ in REGISTRY


def runtime_for(type_):
    return REGISTRY[type_][1]
