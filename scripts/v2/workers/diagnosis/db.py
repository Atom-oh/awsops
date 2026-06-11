"""AWSops v2 — diagnosis_reports CRUD (pg8000). Mirrors workers/db.py conventions."""
import json

_TERMINAL = ("succeeded", "failed", "partial")


def create_report(conn, worker_job_id, tier, requested_by):
    rows = conn.run(
        "INSERT INTO diagnosis_reports (worker_job_id, tier, requested_by, status) "
        "VALUES (:jid, :t, :rb, 'running') RETURNING id",
        jid=worker_job_id, t=tier, rb=requested_by,
    )
    return rows[0][0]


def finish_report(conn, report_id, status, sources_used=None, summary=None,
                  artifact_uri=None, error=None):
    assert status in _TERMINAL
    rows = conn.run(
        "UPDATE diagnosis_reports SET status=:s, sources_used=:su::jsonb, "
        "summary=:sm::jsonb, artifact_uri=:a, error=:e "
        "WHERE id=:id AND status='running' RETURNING id",
        s=status,
        su=json.dumps(sources_used or []),
        sm=json.dumps(summary or {}),
        a=artifact_uri, e=error, id=report_id,
    )
    return len(rows)
