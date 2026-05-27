// ADR-030 Phase 1 dual-write — agentcore_stats Aurora INSERT.
//
// Source of truth during Phase 1 remains data/agentcore-stats.json. This
// module appends each AgentCoreCallRecord to the Aurora `agentcore_stats`
// table so the 7-day parity gate (ADR-030) has a queryable counterpart.
//
// Drift accounting lives inside the writer so callers cannot forget it.
// Schema: see infra-cdk/data/schema.sql (agentcore_stats table).

import { getDb, isAuroraEnabled } from '@/lib/db';
import { recordWrite, recordFailure } from '@/lib/db/drift';
import type { AgentCoreCallRecord } from '@/lib/agentcore-stats';

const SOURCE = 'agentcore_stats';

const INSERT_SQL = `
  INSERT INTO agentcore_stats (
    occurred_at, event_type, gateway, model, duration_ms,
    input_tokens, output_tokens, payload
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
`;

const COUNT_SQL =
  'SELECT COUNT(*)::text AS c FROM agentcore_stats WHERE occurred_at >= $1 AND occurred_at < $2';

export async function recordCallToAurora(record: AgentCoreCallRecord): Promise<void> {
  if (!isAuroraEnabled()) return;

  const eventType = record.route || 'unknown';
  const payload = JSON.stringify({
    used_tools: record.usedTools ?? [],
    success: record.success,
    via: record.via ?? null,
  });
  const occurredAt = record.timestamp ? new Date(record.timestamp) : new Date();

  try {
    const db = await getDb();
    await db.query(INSERT_SQL, [
      occurredAt,
      eventType,
      record.gateway || null,
      record.model || null,
      record.responseTimeMs ?? null,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      payload,
    ]);
    recordWrite(SOURCE);
  } catch (err) {
    recordFailure(SOURCE, err);
    throw err;
  }
}

/**
 * Fire-and-forget wrapper for hot-path call sites (e.g. the AI route's
 * `recordAndSave` helper). Returns void synchronously so the caller is not
 * blocked on Aurora. Errors are caught here — drift accounting already
 * happened inside `recordCallToAurora`.
 */
export function fireAndForgetCallToAurora(record: AgentCoreCallRecord): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  recordCallToAurora(record).catch(() => {
    // Drift counter already incremented inside the writer.
  });
}

export async function countAuroraCalls(since: Date, until: Date): Promise<number> {
  if (!isAuroraEnabled()) return 0;
  const db = await getDb();
  const r = await db.query<{ c: string }>(COUNT_SQL, [since, until]);
  return Number(r.rows[0]?.c ?? 0);
}
