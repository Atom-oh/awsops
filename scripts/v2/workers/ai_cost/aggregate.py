"""Pure helpers for the awsops-only Bedrock cost aggregator (no boto3, unit-testable).

The scheduled Lambda (ai_cost_aggregator.py) uses build_query() against the Bedrock
model-invocation log group and parse_rows() to turn GetQueryResults into daily token rows
for an idempotent UPSERT into ai_usage_daily. Pricing happens later in the web BFF
(web/lib/bedrock.ts), so this module only deals in raw token counts.
"""

# awsops callers are IAM roles named like "awsops-v2-*"; the Bedrock account is shared with
# other workloads, so filtering identity.arn by this substring isolates awsops usage.
AWSOPS_IDENTITY_MATCH = "awsops-v2"


def build_query(match: str = AWSOPS_IDENTITY_MATCH) -> str:
    """CloudWatch Logs Insights query: awsops-only token sums per UTC day × model.

    Notes:
    - Logs Insights has NO coalesce(); use if(ispresent(x), x, 0) so models/events that omit
      the prompt-cache fields don't null out the sum.
    - bin(1d) buckets strictly by UTC day; the aggregator passes a full-UTC-day time window.
    """
    return (
        f"filter identity.arn like /{match}/\n"
        "| stats\n"
        "    sum(if(ispresent(input.inputTokenCount), input.inputTokenCount, 0)) as input_tokens,\n"
        "    sum(if(ispresent(output.outputTokenCount), output.outputTokenCount, 0)) as output_tokens,\n"
        "    sum(if(ispresent(input.cacheReadInputTokenCount), input.cacheReadInputTokenCount, 0)) as cache_read_tokens,\n"
        "    sum(if(ispresent(input.cacheWriteInputTokenCount), input.cacheWriteInputTokenCount, 0)) as cache_write_tokens\n"
        "    by bin(1d) as day, modelId"
    )


def _to_int(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def parse_rows(results) -> list:
    """Map GetQueryResults `results` (list of rows; each row a list of {field,value}) →
    [{day(UTC 'YYYY-MM-DD'), model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}].
    Rows missing day or modelId are skipped; missing token columns default to 0."""
    if not results:
        return []
    out = []
    for row in results:
        cells = {c.get("field"): c.get("value") for c in row if isinstance(c, dict)}
        day = cells.get("day")
        model = cells.get("modelId")
        if not day or not model:
            continue
        out.append({
            "day": str(day)[:10],  # "2026-06-17 00:00:00.000" / "...T..Z" → "2026-06-17" (UTC)
            "model": model,
            "input_tokens": _to_int(cells.get("input_tokens")),
            "output_tokens": _to_int(cells.get("output_tokens")),
            "cache_read_tokens": _to_int(cells.get("cache_read_tokens")),
            "cache_write_tokens": _to_int(cells.get("cache_write_tokens")),
        })
    return out
