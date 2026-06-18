"""EventBridge-scheduled (rate 6h). Aggregates awsops-only Bedrock token usage from the
model-invocation logs (/aws/bedrock/invocation-logs, ap-northeast-2) into ai_usage_daily.

Idempotent: each run re-queries the last LOOKBACK_DAYS FULL UTC days and UPSERT-overwrites the
(day, model) rows, so today/yesterday progressively complete with no overlap double-count and no
data loss. The web BFF (/api/ai-usage) prices the stored raw tokens via web/lib/bedrock.ts.

Read-only against AWS: logs:StartQuery/GetQueryResults/StopQuery + an Aurora write to the
derived ai_usage_daily table only. Never mutates AWS resources.
"""
import datetime
import os
import time

import boto3

import aggregate
import db

LOG_GROUP = os.environ.get("BEDROCK_LOG_GROUP", "/aws/bedrock/invocation-logs")
MATCH = os.environ.get("AWSOPS_IDENTITY_MATCH", aggregate.AWSOPS_IDENTITY_MATCH)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "3"))
_logs = boto3.client("logs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))

_UPSERT = (
    "INSERT INTO ai_usage_daily "
    "(day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, updated_at) "
    "VALUES (:d, :m, :i, :o, :cr, :cw, now()) "
    "ON CONFLICT (day, model) DO UPDATE SET "
    "input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, "
    "cache_read_tokens = EXCLUDED.cache_read_tokens, cache_write_tokens = EXCLUDED.cache_write_tokens, "
    "updated_at = now()"
)

# Self-heal: rows written before modelId normalization were keyed by the full inference-profile ARN
# (which contains '/'); normalize_model() now stores canonical ids that never contain '/'. Delete the
# stale ARN-keyed rows so the read path (/api/ai-usage GROUP BY model) never double-counts an ARN-key
# row + a bare-key row as two models. SCOPED to the re-queried lookback window (`day >= :start`) and run
# only when the Insights query returned rows — so it deletes ONLY rows that are about to be re-inserted
# as canonical, never wiping older history we won't re-derive, and never wiping on an empty/failed query.
_CLEANUP_LEGACY = "DELETE FROM ai_usage_daily WHERE model LIKE '%/%' AND day >= :start"


def _run_insights(start_epoch: int, end_epoch: int):
    """StartQuery → poll GetQueryResults with backoff → StopQuery on timeout. Returns results (list)."""
    qid = _logs.start_query(
        logGroupName=LOG_GROUP,
        startTime=start_epoch,
        endTime=end_epoch,
        queryString=aggregate.build_query(MATCH),
    )["queryId"]
    delay = 0.5
    for _ in range(10):
        r = _logs.get_query_results(queryId=qid)
        status = r.get("status")
        if status == "Complete":
            return r.get("results", [])
        if status in ("Failed", "Cancelled", "Timeout"):
            print(f"ai_cost_aggregator: insights query {status}")
            return []
        time.sleep(delay)
        delay = min(delay * 1.6, 5.0)
    try:
        _logs.stop_query(queryId=qid)
    except Exception:
        pass
    print("ai_cost_aggregator: insights query did not complete in budget; stopped")
    return []


def lambda_handler(_event, _ctx):
    now = datetime.datetime.now(datetime.timezone.utc)
    start_day = (now - datetime.timedelta(days=LOOKBACK_DAYS)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    rows = aggregate.parse_rows(_run_insights(int(start_day.timestamp()), int(now.timestamp())))
    conn = db.connect()
    upserted = 0
    try:
        if rows:
            # window-scoped self-heal: drop stale ARN-keyed rows ONLY for days we just re-queried (they
            # get re-inserted as canonical below). Skipped when rows is empty so a failed Insights query
            # never wipes data.
            conn.run(_CLEANUP_LEGACY, start=start_day.strftime("%Y-%m-%d"))
        for row in rows:
            conn.run(
                _UPSERT,
                d=row["day"], m=row["model"],
                i=row["input_tokens"], o=row["output_tokens"],
                cr=row["cache_read_tokens"], cw=row["cache_write_tokens"],
            )
            upserted += 1
    finally:
        conn.close()  # db.connect() returns a fresh pg8000 connection each call (matches reaper.py)
    print(f"ai_cost_aggregator: upserted {upserted} day×model rows (lookback {LOOKBACK_DAYS}d)")
    return {"upserted": upserted}
