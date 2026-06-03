"""SFN Catch-invoked. Input: {job_id, error}. Sets failed+error CONDITIONALLY (won't overwrite a
worker's succeeded). Exists because SFN cannot write VPC Aurora directly."""
import json
import db


def lambda_handler(event, _ctx):
    job_id = event["job_id"]
    err = event.get("error")
    if isinstance(err, (dict, list)):
        err = json.dumps(err)[:2000]
    conn = db.connect()
    try:
        n = db.finish_job(conn, job_id, "failed", error=(err or "worker failed (SFN catch)"))
        return {"job_id": job_id, "updated": n}
    finally:
        conn.close()
