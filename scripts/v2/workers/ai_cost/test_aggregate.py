"""Tests for the pure ai-cost aggregation helpers (no boto3)."""
import aggregate as A


def test_build_query_filters_awsops_identity():
    q = A.build_query(A.AWSOPS_IDENTITY_MATCH)
    assert "identity.arn" in q
    assert "awsops-v2" in q
    # CloudWatch Logs Insights has NO coalesce() — must use ispresent()/if().
    assert "coalesce" not in q
    assert "ispresent(input.inputTokenCount)" in q
    assert "ispresent(output.outputTokenCount)" in q
    assert "ispresent(input.cacheReadInputTokenCount)" in q
    assert "ispresent(input.cacheWriteInputTokenCount)" in q
    # daily buckets per model
    assert "bin(1d)" in q
    assert "modelId" in q
    # the four aggregate aliases the parser expects
    for alias in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"):
        assert alias in q


def _row(day, model, **toks):
    """Build one Logs-Insights GetQueryResults row (list of {field,value})."""
    cells = [{"field": "day", "value": day}, {"field": "modelId", "value": model}]
    for k, v in toks.items():
        cells.append({"field": k, "value": str(v)})
    return cells


def test_parse_rows_maps_tokens_and_normalizes_day():
    results = [
        _row("2026-06-17 00:00:00.000", "global.anthropic.claude-sonnet-4-6",
             input_tokens=1500, output_tokens=800, cache_read_tokens=200, cache_write_tokens=50),
    ]
    rows = A.parse_rows(results)
    assert len(rows) == 1
    r = rows[0]
    assert r["day"] == "2026-06-17"  # bin(1d) timestamp → UTC date
    assert r["model"] == "global.anthropic.claude-sonnet-4-6"
    assert r["input_tokens"] == 1500
    assert r["output_tokens"] == 800
    assert r["cache_read_tokens"] == 200
    assert r["cache_write_tokens"] == 50


def test_parse_rows_missing_token_fields_default_zero():
    results = [_row("2026-06-16T00:00:00.000Z", "global.anthropic.claude-haiku-4-5", input_tokens=10)]
    rows = A.parse_rows(results)
    r = rows[0]
    assert r["day"] == "2026-06-16"
    assert r["input_tokens"] == 10
    assert r["output_tokens"] == 0
    assert r["cache_read_tokens"] == 0
    assert r["cache_write_tokens"] == 0


def test_parse_rows_empty():
    assert A.parse_rows([]) == []
    assert A.parse_rows(None) == []


def test_parse_rows_skips_rows_without_day_or_model():
    results = [[{"field": "modelId", "value": "x"}], [{"field": "day", "value": "2026-06-17 00:00:00.000"}]]
    assert A.parse_rows(results) == []
