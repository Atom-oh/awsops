"""SNS email notification for SCHEDULED AI-diagnosis reports (v1 report-scheduler parity).

When a scheduled diagnosis report finishes, the worker publishes a concise plaintext summary + a deep
link to the full report to one dedicated SNS topic; SNS fans it out to the confirmed email subscribers
(the mailing list, managed in-app via /api/diagnosis/subscribers).

Governance (ADR-040/041): the ONLY write here is sns:Publish to a single, terraform-provisioned, IAM-
scoped topic — a governed external-comms write, NOT the permanently-frozen AWS-resource-mutation class.
Read-only on all diagnosis data sources. Best-effort by contract: a publish failure (throttle, bad
config, SNS outage) is logged and swallowed — it must NEVER fail or downgrade the report.
"""
import re

import boto3

_MAX_SUMMARY = 1200
# SNS requires an ASCII Subject (≤100 chars, no leading whitespace/newlines). The Korean title goes in
# the body — a non-ASCII Subject is rejected by SNS (→ publish fails → no email). Keep this ASCII.
_SUBJECT = "[AWSops] Scheduled AI Diagnosis Report"

_sns = None


def _client(region=None):
    global _sns
    if _sns is None:
        _sns = boto3.client("sns", region_name=region) if region else boto3.client("sns")
    return _sns


def _strip_markdown(text):
    """Markdown → readable plaintext for an SNS email body (email is plaintext, not HTML)."""
    out = []
    for line in text.splitlines():
        s = line.rstrip()
        # GFM table separator row (`| --- | :--: |`) carries no info in plaintext → drop it.
        if re.match(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$", s):
            continue
        s = re.sub(r"^#{1,6}\s+", "", s)            # heading markers
        s = s.replace("|", "  ")                     # table cell pipes → spaces
        s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)      # bold
        s = re.sub(r"`([^`]+)`", r"\1", s)           # inline code
        out.append(s)
    plain = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
    return plain


def summarize(md, limit=_MAX_SUMMARY):
    """Extract the executive-summary (the first `## ` section) as a plaintext teaser, truncated."""
    if not md:
        return ""
    m = re.search(r"(?m)^##\s+.*$", md)
    body = md[m.start():] if m else md
    # cut at the next section header (skip the leading '## ' we just matched)
    nxt = re.search(r"(?m)^##\s+", body[3:])
    if nxt:
        body = body[: nxt.start() + 3]
    plain = _strip_markdown(body)
    if len(plain) > limit:
        plain = plain[:limit].rstrip() + " …"
    return plain


def build_message(title, md, report_url):
    """Return (subject, body) for the SNS publish. Subject is ASCII; title/teaser/link in the body."""
    heading = (title or "AI 진단 리포트").strip()
    teaser = summarize(md)
    parts = [heading, "=" * 40, ""]
    if teaser:
        parts += [teaser, ""]
    parts += ["-" * 40, "전체 리포트 보기:"]
    if report_url:
        parts.append(report_url)
    parts += [
        "",
        "이 메일은 AWSops 자동 진단 스케줄에 의해 발송되었습니다.",
        "수신 거부 / 구독 관리는 관리자에게 문의하세요.",
    ]
    return _SUBJECT, "\n".join(parts)


def publish_report(topic_arn, title, md, report_url, region=None):
    """Best-effort publish to the diagnosis SNS topic. Returns the MessageId, or None on any
    failure / when no topic is configured. NEVER raises (notification must not fail the report)."""
    if not topic_arn:
        return None
    try:
        subject, body = build_message(title, md, report_url)
        resp = _client(region).publish(TopicArn=topic_arn, Subject=subject, Message=body)
        mid = resp.get("MessageId")
        print(f"[notify] published scheduled report → {topic_arn} (MessageId={mid})")
        return mid
    except Exception as e:  # noqa: BLE001 — notification is best-effort; never fail the report
        print(f"[notify] publish failed (non-fatal): {e}")
        return None
