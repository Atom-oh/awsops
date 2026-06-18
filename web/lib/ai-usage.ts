// awsops-only Bedrock cost: price the pre-aggregated ai_usage_daily token rows.
// Pricing is single-sourced in bedrock.ts; this module only maps DB rows → priced model usage.
import { getModelLabel, getModelPricing, computeCost, type CostBreakdown } from './bedrock';

/** A SUM-by-model row from `ai_usage_daily` (snake_case, as returned by node-pg). */
export interface UsageRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ModelUsage {
  model: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: CostBreakdown;
}

export interface UsageSummary {
  models: ModelUsage[];
  totalCost: number;
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Canonical modelId = the segment after the last '/'. Bedrock logs modelId inconsistently — the SDK
 * worker logs the full inference-profile ARN (".../inference-profile/global.anthropic.claude-opus-4-8")
 * while AgentCore logs the bare id ("global.anthropic.claude-opus-4-8"). The aggregator normalizes on
 * write, but normalizing again HERE (the read path) makes correctness order-independent: any leftover
 * ARN-keyed row collapses into its bare-key sibling at read time, so the total can never double-count
 * regardless of what's in ai_usage_daily or the order the aggregator ran in.
 */
const canonicalModel = (m: string): string => m.slice(m.lastIndexOf('/') + 1) || m;

/** Price each model row via bedrock.ts and total it. Pure — no DB/SDK.
 * Rows are first collapsed by canonical modelId so ARN-key + bare-key variants of one model merge. */
export function priceUsage(rows: UsageRow[] | null | undefined): UsageSummary {
  if (!rows || rows.length === 0) return { models: [], totalCost: 0 };
  const merged = new Map<string, UsageRow>();
  for (const r of rows) {
    const model = canonicalModel(r.model);
    const cur = merged.get(model) ?? {
      model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    };
    cur.input_tokens += n(r.input_tokens);
    cur.output_tokens += n(r.output_tokens);
    cur.cache_read_tokens += n(r.cache_read_tokens);
    cur.cache_write_tokens += n(r.cache_write_tokens);
    merged.set(model, cur);
  }
  const models: ModelUsage[] = [...merged.values()].map((r) => {
    const usage = {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
    };
    const cost = computeCost(usage, getModelPricing(r.model));
    return { model: r.model, label: getModelLabel(r.model), ...usage, cost };
  });
  const totalCost = models.reduce((s, m) => s + m.cost.total, 0);
  return { models, totalCost };
}
