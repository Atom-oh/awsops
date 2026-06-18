-- since: 2.1.0
-- One-time cleanup for the ai-cost modelId normalization.
--
-- Rows written before normalization were keyed by the full Bedrock inference-profile ARN
-- (modelId contained '/', e.g. "arn:aws:bedrock:…:inference-profile/global.anthropic.claude-opus-4-8"),
-- while AgentCore logged the bare id ("global.anthropic.claude-opus-4-8"). The aggregator now stores the
-- canonical id (segment after the last '/'), which never contains '/'. Left as-is, the read path
-- (/api/ai-usage GROUP BY model) would count an ARN-key row AND its bare-key row as two models →
-- double-count for any overlapping day.
--
-- This MERGES each legacy ARN row into its canonical key, SUMMING tokens so historical usage is
-- PRESERVED (no data loss), then deletes the legacy rows. Idempotent: afterward no '%/%' rows remain,
-- so a re-run is a no-op. The runner wraps this file in a single transaction (atomic). The recurring
-- aggregator no longer touches legacy rows — this one-shot owns the cleanup.

INSERT INTO ai_usage_daily AS t
  (day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, updated_at)
SELECT day,
       regexp_replace(model, '^.*/', '') AS canonical_model,
       SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), now()
FROM ai_usage_daily
WHERE model LIKE '%/%'
GROUP BY day, regexp_replace(model, '^.*/', '')
ON CONFLICT (day, model) DO UPDATE SET
  input_tokens       = t.input_tokens       + EXCLUDED.input_tokens,
  output_tokens      = t.output_tokens      + EXCLUDED.output_tokens,
  cache_read_tokens  = t.cache_read_tokens  + EXCLUDED.cache_read_tokens,
  cache_write_tokens = t.cache_write_tokens + EXCLUDED.cache_write_tokens,
  updated_at         = now();

DELETE FROM ai_usage_daily WHERE model LIKE '%/%';
