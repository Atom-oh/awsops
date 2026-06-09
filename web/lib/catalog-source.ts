// web/lib/catalog-source.ts
// ADR-031 Phase 1 — single catalog reader for the chat hot path. Aurora + 30s cache.
import { listAgentsWithSkills, type AgentWithSkills } from '@/lib/catalog';

const TTL_MS = 30_000; // acceptable-staleness window for non-security enable changes (Addendum #2)
let cache: { at: number; data: AgentWithSkills[] } | null = null;

export function _clearCacheForTests() { cache = null; }

export async function getEnabledCustomAgents(): Promise<AgentWithSkills[]> {
  if (!process.env.AURORA_ENDPOINT) return [];
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  try {
    const all = await listAgentsWithSkills({ enabledOnly: true });
    const data = all.filter((a) => a.tier === 'custom');
    cache = { at: now, data };
    return data;
  } catch {
    return []; // resolver falls back to built-in; assistant never breaks
  }
}
