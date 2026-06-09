// web/lib/trace.ts
// ADR-031 Phase 1 — traceability: record custom-agent invocations into agentcore_stats.
import { getPool } from '@/lib/db';

export interface CustomAgentTrace {
  gateway: string;
  userSub: string;
  agentName: string;
  agentVersion?: number;
  tier: 'builtin' | 'custom';
  skillHashes: string[];
}

/** Fire-and-forget. Records {agentName, agentVersion, skillHashes, tier} for reproducibility. Never throws. */
export async function recordCustomAgentTrace(t: CustomAgentTrace): Promise<void> {
  if (!process.env.AURORA_ENDPOINT) return;
  try {
    await getPool().query(
      `INSERT INTO agentcore_stats (event_type, gateway, user_sub, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      ['custom_agent_invoke', t.gateway, t.userSub, JSON.stringify({
        agentName: t.agentName, agentVersion: t.agentVersion, tier: t.tier, skillHashes: t.skillHashes,
      })],
    );
  } catch { /* tracing must not break chat */ }
}
