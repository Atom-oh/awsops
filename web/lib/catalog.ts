// web/lib/catalog.ts
// ADR-031 Phase 1 — Aurora-backed skill/agent catalog (CRUD + queries + SHA-256).
import { createHash } from 'crypto';
import { getPool } from '@/lib/db';

export type Tier = 'builtin' | 'custom';

export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  toolAllowlist: string[];
  tier: Tier;
  createdBy?: string;
}
export interface AgentInput {
  name: string;
  description: string;
  persona: string;
  routingKeywords: string[];
  gateway: string;
  model?: string;
  tier: Tier;
  createdBy?: string;
}
export interface SkillRef {
  name: string; instructions: string; contentHash: string; ord: number; toolAllowlist: string[];
}
export interface AgentWithSkills {
  id: number; name: string; description: string; persona: string; gateway: string;
  tier: Tier; version: number; enabled: boolean; routingKeywords: string[]; skills: SkillRef[];
}

/** SHA-256 over canonical JSON of integrity-relevant fields. Order-independent on toolAllowlist. */
export function computeSkillHash(s: { name: string; description: string; instructions: string; toolAllowlist: string[] }): string {
  const canonical = JSON.stringify({
    name: s.name, description: s.description, instructions: s.instructions,
    toolAllowlist: [...s.toolAllowlist].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function upsertSkill(s: SkillInput): Promise<number> {
  const hash = computeSkillHash(s);
  const { rows } = await getPool().query(
    `INSERT INTO skills (name, description, instructions, tool_allowlist, tier, content_hash, created_by, enabled)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7, false)
     ON CONFLICT (name) DO UPDATE
       SET description = EXCLUDED.description,
           instructions = EXCLUDED.instructions,
           tool_allowlist = EXCLUDED.tool_allowlist,
           content_hash = EXCLUDED.content_hash,
           version = skills.version + 1,
           enabled = false,
           updated_at = NOW()
     RETURNING id`,
    [s.name, s.description, s.instructions, JSON.stringify(s.toolAllowlist), s.tier, hash, s.createdBy ?? null],
  );
  return rows[0].id;
}

export async function upsertAgent(a: AgentInput): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO agents (name, description, persona, routing_keywords, gateway, model, tier, created_by, enabled)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8, false)
     ON CONFLICT (name) DO UPDATE
       SET description = EXCLUDED.description, persona = EXCLUDED.persona,
           routing_keywords = EXCLUDED.routing_keywords, gateway = EXCLUDED.gateway,
           model = EXCLUDED.model, version = agents.version + 1, enabled = false, updated_at = NOW()
     RETURNING id`,
    [a.name, a.description, a.persona, JSON.stringify(a.routingKeywords), a.gateway, a.model ?? null, a.tier, a.createdBy ?? null],
  );
  return rows[0].id;
}

export async function attachSkill(agentId: number, skillId: number, ord = 0): Promise<void> {
  await getPool().query(
    `INSERT INTO agent_skills (agent_id, skill_id, ord) VALUES ($1,$2,$3)
     ON CONFLICT (agent_id, skill_id) DO UPDATE SET ord = EXCLUDED.ord`,
    [agentId, skillId, ord],
  );
}

export async function setEnabled(kind: 'skill' | 'agent', id: number, enabled: boolean): Promise<void> {
  const table = kind === 'skill' ? 'skills' : 'agents';
  // builtin rows are never togglable from the API (guarded at the route too)
  await getPool().query(`UPDATE ${table} SET enabled = $1, updated_at = NOW() WHERE id = $2 AND tier = 'custom'`, [enabled, id]);
}

export async function listSkills(): Promise<Array<{ id: number; name: string; description: string; tier: Tier; enabled: boolean; version: number; contentHash: string }>> {
  const { rows } = await getPool().query(
    `SELECT id, name, description, tier, enabled, version, content_hash FROM skills ORDER BY name`,
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number, name: r.name as string, description: r.description as string,
    tier: r.tier as Tier, enabled: r.enabled as boolean, version: r.version as number, contentHash: r.content_hash as string,
  }));
}

export async function listAgentsWithSkills(opts?: { enabledOnly?: boolean }): Promise<AgentWithSkills[]> {
  const where = opts?.enabledOnly ? 'WHERE a.enabled = true' : '';
  const { rows } = await getPool().query(
    `SELECT a.id, a.name, a.description, a.persona, a.gateway, a.tier, a.version, a.enabled,
            a.routing_keywords,
            COALESCE(json_agg(json_build_object(
              'name', s.name, 'instructions', s.instructions, 'content_hash', s.content_hash,
              'ord', ags.ord, 'tool_allowlist', s.tool_allowlist
            ) ORDER BY ags.ord) FILTER (WHERE s.id IS NOT NULL), '[]') AS skills
     FROM agents a
     LEFT JOIN agent_skills ags ON ags.agent_id = a.id
     LEFT JOIN skills s ON s.id = ags.skill_id AND s.enabled = true
     ${where}
     GROUP BY a.id
     ORDER BY a.name`,
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number, name: r.name as string, description: r.description as string,
    persona: r.persona as string, gateway: r.gateway as string, tier: r.tier as Tier,
    version: r.version as number, enabled: r.enabled as boolean,
    routingKeywords: (r.routing_keywords as string[]) ?? [],
    skills: ((r.skills as Array<Record<string, unknown>>) ?? []).map((sk) => ({
      name: sk.name as string, instructions: sk.instructions as string,
      contentHash: sk.content_hash as string, ord: sk.ord as number,
      toolAllowlist: (sk.tool_allowlist as string[]) ?? [],
    })),
  }));
}

export async function writeAudit(a: { actor: string; action: string; objectType: string; objectId: string; beforeHash?: string; afterHash?: string }): Promise<void> {
  await getPool().query(
    `INSERT INTO customization_audit (actor, action, object_type, object_id, before_hash, after_hash)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [a.actor, a.action, a.objectType, a.objectId, a.beforeHash ?? null, a.afterHash ?? null],
  );
}
