// web/lib/trace.ts
// ADR-031 Phase 1 — traceability: record custom-agent invocations into agentcore_stats.
import { getPool } from '@/lib/db';
import { normalizeEvidence, type ChatEvidence, type Outcome } from './chat-evidence';

export interface CustomAgentTrace {
  gateway: string;
  userSub: string;
  agentName: string;
  agentVersion?: number;
  tier: 'builtin' | 'custom';
  skillHashes: string[];
  spaceVersion?: number; // ADR-031 Phase 2 traceability
}

/** Fire-and-forget. Records {agentName, agentVersion, skillHashes, tier} for reproducibility. Never throws. */
export async function recordCustomAgentTrace(t: CustomAgentTrace): Promise<void> {
  if (!process.env.AURORA_ENDPOINT) return;
  try {
    await getPool().query(
      `INSERT INTO agentcore_stats (event_type, gateway, user_sub, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      ['custom_agent_invoke', t.gateway, t.userSub, JSON.stringify({
        agentName: t.agentName, agentVersion: t.agentVersion, tier: t.tier,
        skillHashes: t.skillHashes, spaceVersion: t.spaceVersion,
      })],
    );
  } catch { /* tracing must not break chat */ }
}

// v1-parity ops stats (v1 src/lib/agentcore-stats.ts): every BUILTIN chat invoke is recorded too,
// so the operator can see call volume / success rate / latency per gateway — not only custom-agent
// traces and daily token aggregates.
export interface ChatInvokeTrace {
  gateway: string;
  userSub: string;
  elapsedMs: number;
  success: boolean;
  via?: string;   // 'multi:a+b' | 'bedrock-direct-fallback' | 'code-interpreter' | undefined
  model?: string;
  toolCount?: number;
  usage?: { inputTokens: number; outputTokens: number };
  evidence?: ChatEvidence;
}

/** Fire-and-forget chat-invoke stat row. Uses the table's dedicated columns
 *  (model/duration_ms/input_tokens/output_tokens) so rollups stay SQL-friendly. Never throws. */
export async function recordChatInvoke(t: ChatInvokeTrace): Promise<void> {
  if (!process.env.AURORA_ENDPOINT) return;
  try {
    const { status, evidenceOmitted } = coarseOutcome(t);
    await getPool().query(
      `INSERT INTO agentcore_stats (event_type, gateway, model, user_sub, duration_ms, input_tokens, output_tokens, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      ['chat_invoke', t.gateway, t.model ?? null, t.userSub, Math.round(t.elapsedMs),
        t.usage?.inputTokens ?? null, t.usage?.outputTokens ?? null,
        JSON.stringify({ success: status === 'unverified' ? null : status === 'success',
          status, via: t.via, toolCount: t.toolCount, ...(evidenceOmitted ? { evidenceOmitted } : {}) })],
    );
  } catch { /* tracing must not break chat */ }
}

export interface ChatInvokeStats {
  totalCalls: number;
  successRate: number | null;      // 0..1, null when no calls
  avgElapsedMs: number | null;
  unverifiedCalls: number;
  byGateway: { gateway: string; calls: number; assessedCalls: number; successRate: number | null; avgElapsedMs: number }[];
  recent: { gateway: string; success: boolean | null; status: Outcome; evidenceOmitted?: boolean;
    elapsedMs: number; via?: string; model?: string; at: string }[];
}

/** Details stay in owner-checked chat metadata. Also projects historical receipt-bearing rows. */
function coarseOutcome(payload: { evidence?: unknown; status?: unknown; success?: unknown; evidenceOmitted?: unknown } | null | undefined,
  historical = false):
  { status: Outcome; evidenceOmitted: boolean } {
  const evidence = normalizeEvidence(payload?.evidence);
  const invalidEvidence = payload?.evidence !== undefined && !evidence;
  const storedStatus = typeof payload?.status === 'string' && ['success', 'error', 'empty', 'partial', 'unverified'].includes(payload.status)
    ? payload.status as Outcome : payload?.success === false ? 'error' : 'unverified';
  let status = evidence?.status ?? (invalidEvidence && !['error', 'partial'].includes(storedStatus) ? 'unverified' : storedStatus);
  if (historical && payload?.evidence !== undefined) {
    // Match the aggregate CASE: historical detailed rows never certify success.
    const rawStatus = payload.evidence && typeof payload.evidence === 'object' && 'status' in payload.evidence
      ? payload.evidence.status : undefined;
    status = payload.status === 'error' || payload.status === 'partial' ? payload.status
      : rawStatus === 'error' || rawStatus === 'partial' ? rawStatus : 'unverified';
  }
  const evidenceOmitted = invalidEvidence || payload?.evidenceOmitted === true || !!(evidence?.truncated || evidence?.invalid
    || evidence?.domains.some(d => d.truncated || d.invalid || d.receipts.some(r => r.quality?.truncated || r.quality?.invalid || r.quality?.unsupported)));
  return { status, evidenceOmitted };
}

/** Aggregate chat_invoke stats over the trailing N days (v1 /api/agentcore?action=stats parity). */
export async function getChatInvokeStats(days = 7, recentLimit = 20): Promise<ChatInvokeStats> {
  const empty: ChatInvokeStats = { totalCalls: 0, successRate: null, avgElapsedMs: null, unverifiedCalls: 0, byGateway: [], recent: [] };
  if (!process.env.AURORA_ENDPOINT) return empty;
  try {
    const pool = getPool();
    // Historical receipt-bearing payloads predate completion checks. Retain coarse failures;
    // do not include their claimed successes in the assessed denominator. No data rewrite.
    const agg = await pool.query(
      `SELECT gateway,
              count(*)::int AS calls,
              count(*) FILTER (WHERE status <> 'unverified')::int AS assessed_calls,
              avg(CASE WHEN status = 'unverified' THEN NULL WHEN status = 'success' THEN 1 ELSE 0 END)::float AS success_rate,
              avg(duration_ms)::float AS avg_ms
       FROM (
         SELECT gateway, duration_ms,
           CASE WHEN payload->'evidence' IS NOT NULL THEN
                  CASE WHEN payload->>'status' IN ('error','partial') THEN payload->>'status'
                       WHEN payload->'evidence'->>'status' IN ('error','partial') THEN payload->'evidence'->>'status'
                       ELSE 'unverified' END
                WHEN payload->>'status' IN ('success','partial','error','empty','unverified') THEN payload->>'status'
                WHEN payload->>'success' = 'false' THEN 'error' ELSE 'unverified' END AS status
         FROM agentcore_stats
         WHERE event_type = 'chat_invoke' AND occurred_at > now() - ($1 || ' days')::interval
       ) calls
       GROUP BY gateway ORDER BY calls DESC`,
      [String(days)],
    );
    const recent = await pool.query(
      `SELECT gateway, model, duration_ms, payload, occurred_at FROM agentcore_stats
       WHERE event_type = 'chat_invoke' ORDER BY id DESC LIMIT $1`,
      [recentLimit],
    );
    const byGateway = agg.rows.map((r) => ({
      gateway: r.gateway as string, calls: r.calls as number,
      assessedCalls: Number(r.assessed_calls ?? 0),
      successRate: r.success_rate as number | null, avgElapsedMs: Math.round(r.avg_ms as number),
    }));
    const totalCalls = byGateway.reduce((s, g) => s + g.calls, 0);
    const assessedCalls = byGateway.reduce((s, g) => s + g.assessedCalls, 0);
    const successRate = assessedCalls
      ? byGateway.reduce((s, g) => s + (g.successRate ?? 0) * g.assessedCalls, 0) / assessedCalls : null;
    const avgElapsedMs = totalCalls
      ? Math.round(byGateway.reduce((s, g) => s + g.avgElapsedMs * g.calls, 0) / totalCalls) : null;
    return {
      totalCalls, successRate, avgElapsedMs, byGateway, unverifiedCalls: totalCalls - assessedCalls,
      recent: recent.rows.map((r) => {
        const { status, evidenceOmitted } = coarseOutcome(r.payload, true);
        return {
        gateway: r.gateway as string,
        success: status === 'unverified' ? null : status === 'success', status, ...(evidenceOmitted ? { evidenceOmitted } : {}),
        elapsedMs: Number(r.duration_ms ?? 0),
        via: r.payload?.via ?? undefined,
        model: (r.model as string | null) ?? undefined,
        at: new Date(r.occurred_at).toISOString(),
      }; }),
    };
  } catch {
    return empty;
  }
}
