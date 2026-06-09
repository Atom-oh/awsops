// src/lib/db/token-budget-writer.ts
// ADR-033 Phase 2 dual-write — durable per-(account,user,day) token budget.
// Source of truth = Aurora ai_token_budget; token-budget.ts keeps an in-process
// Map fast-path seeded from here on cold start. Mirrors agentcore-stats-writer.
import { getDb, isAuroraEnabled } from '@/lib/db';
import { recordWrite, recordFailure } from '@/lib/db/drift';

const SOURCE = 'ai_token_budget';

const UPSERT_SQL = `
  INSERT INTO ai_token_budget (account_id, user_sub, day, input_tokens, output_tokens)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (account_id, user_sub, day) DO UPDATE SET
    input_tokens = ai_token_budget.input_tokens + EXCLUDED.input_tokens,
    output_tokens = ai_token_budget.output_tokens + EXCLUDED.output_tokens,
    updated_at = now()
`;

const READ_SQL = `
  SELECT (input_tokens + output_tokens)::text AS total
  FROM ai_token_budget WHERE account_id = $1 AND user_sub = $2 AND day = $3
`;

export async function recordSpendToAurora(
  accountId: string, userSub: string, day: string, inputTokens: number, outputTokens: number,
): Promise<void> {
  if (!isAuroraEnabled()) return;
  try {
    const db = await getDb();
    await db.query(UPSERT_SQL, [accountId, userSub, day, Math.max(0, inputTokens), Math.max(0, outputTokens)]);
    recordWrite(SOURCE);
  } catch (err) {
    recordFailure(SOURCE, err);
    throw err;
  }
}

export function fireAndForgetSpendToAurora(
  accountId: string, userSub: string, day: string, inputTokens: number, outputTokens: number,
): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  recordSpendToAurora(accountId, userSub, day, inputTokens, outputTokens).catch(() => {
    // drift counter already incremented inside the writer
  });
}

export async function readBudgetTotalFromAurora(accountId: string, userSub: string, day: string): Promise<number> {
  if (!isAuroraEnabled()) return 0;
  const db = await getDb();
  const r = await db.query<{ total: string }>(READ_SQL, [accountId, userSub, day]);
  return Number(r.rows[0]?.total ?? 0);
}
