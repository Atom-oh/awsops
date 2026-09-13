// web/lib/catalog-source.ts
// Authoritative per-turn catalog read: cached skill instructions cannot survive revocation.
// Phase 2: account-aware. NO agent_spaces row ⇒ Phase-1 global behavior (all
// globally-enabled customs). A row scopes the set to its enabled_agent_ids.
//
// Agent Space agent membership and the resolver's tool cap govern runtime scope.
// enabled_skill_ids is persisted metadata; neither the attachment UI/API nor this
// reader enforces it. Only globally enabled attached skills enter the composition.
import { listAgentsWithSkills, type AgentWithSkills } from '@/lib/catalog';
import { getAgentSpace } from '@/lib/agent-space';
import { isReservedAgentName } from '@/lib/skill-validation';

export async function getEnabledCustomAgents(accountId?: string): Promise<AgentWithSkills[]> {
  if (!process.env.AURORA_ENDPOINT) return [];
  const acct = accountId ?? 'self';
  // Policy failures must reach the caller's 503 path, never a global/built-in fallback.
  const space = await getAgentSpace(acct); // null only for a confirmed missing row
  try {
    const all = await listAgentsWithSkills({ enabledOnly: true });
    // Preserve historical rows, but never expose/run command-name collisions as custom agents.
    let data = all.filter((a) => a.tier === 'custom' && !isReservedAgentName(a.name));

    if (space) {
      const agentSet = new Set(space.enabledAgentIds);
      data = data.filter((a) => agentSet.has(a.id));     // account-scoped subset
    }
    return data;
  } catch {
    return []; // resolver falls back to built-in; assistant never breaks
  }
}
