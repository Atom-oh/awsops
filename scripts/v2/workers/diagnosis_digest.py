"""EventBridge-scheduled (~15min). Batches every diagnosis_reports row with notified_at IS NULL
into ONE SNS digest email instead of the prior one-email-per-completion path (see
diagnosis/notify.py's module docstring for why). Read-only on all diagnosis data sources except the
notified_at stamp; sns:Publish is the only external write (ADR-040/041 governed external-comms,
same topic/recipients as the retired per-report path). No-op (no publish, no DB write) when there is
nothing pending — an empty digest is not sent."""
import os

import db
from diagnosis import db as ddb
from diagnosis import notify


def lambda_handler(_event, _ctx):
    conn = db.connect()
    try:
        pending = ddb.list_pending_notifications(conn)
        if not pending:
            return {"digested": 0}
        domain = os.environ.get("APP_DOMAIN", "")
        reports = [
            {
                "title": r["title"],
                "report_url": f"https://{domain}/ai-diagnosis?report={r['id']}" if domain else "",
            }
            for r in pending
        ]
        topic = os.environ.get("DIAGNOSIS_SNS_TOPIC_ARN", "")
        if topic:
            notify.publish_digest(topic, reports, region=os.environ.get("AWS_REGION"))
        # Stamp notified_at regardless of whether a topic is configured (flag-off / no topic still
        # drains the backlog so a later flag-on doesn't suddenly email a huge historical batch).
        ddb.mark_notified(conn, [r["id"] for r in pending])
        return {"digested": len(pending)}
    finally:
        conn.close()
