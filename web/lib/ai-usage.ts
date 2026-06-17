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

/** Price each model row via bedrock.ts and total it. Pure — no DB/SDK. */
export function priceUsage(rows: UsageRow[] | null | undefined): UsageSummary {
  if (!rows || rows.length === 0) return { models: [], totalCost: 0 };
  const models: ModelUsage[] = rows.map((r) => {
    const usage = {
      inputTokens: n(r.input_tokens),
      outputTokens: n(r.output_tokens),
      cacheReadTokens: n(r.cache_read_tokens),
      cacheWriteTokens: n(r.cache_write_tokens),
    };
    const cost = computeCost(usage, getModelPricing(r.model));
    return { model: r.model, label: getModelLabel(r.model), ...usage, cost };
  });
  const totalCost = models.reduce((s, m) => s + m.cost.total, 0);
  return { models, totalCost };
}
