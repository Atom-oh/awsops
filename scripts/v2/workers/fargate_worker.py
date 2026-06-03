"""Fargate worker entrypoint. Args: --job-id <id> [--oom]. Reads the job, runs the handler; --oom
allocates beyond the task memory limit to force an OOM kill (exit 137) -> SFN RunTask.sync catches
-> status_updater sets failed -> proves web is unaffected (spec §5)."""
import argparse
import db
import handlers

_OOM_CHUNK = 64 * 1024 * 1024  # OOM demo: 64 MiB allocation step until the task memory limit kills us


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--oom", action="store_true")
    args = ap.parse_args()
    conn = db.connect()
    try:
        if db.claim_running(conn, args.job_id, runtime="fargate") == 0:
            return  # already terminal/claimed (C7)
        job = db.get_job(conn, args.job_id)
        if job is None:
            raise SystemExit("job not found")
        if args.oom:
            hog = []
            while True:
                hog.append(bytearray(_OOM_CHUNK))  # allocate until OOM-killed
        # DB payload may be JSON null/scalar; coerce non-dict to {} (the SFN/lambda path is trusted).
        payload = job["payload"] if isinstance(job.get("payload"), dict) else {}
        fn, _rt = handlers.REGISTRY[job["type"]]
        result, _artifact = fn(payload, bool(job.get("dry_run")))  # C15: inline result only; NULL-safe dry_run
        db.finish_job(conn, args.job_id, "succeeded", result=result)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
