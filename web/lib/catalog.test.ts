// web/lib/catalog.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
const connect = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query, connect }) }));

import { computeSkillHash, upsertSkill, upsertAgent, attachSkill, listSkills, listAgentsWithSkills, writeAudit, isCustomAgentEnabled } from './catalog';
import { resolveAgent } from './agent-resolver';

beforeEach(() => { query.mockReset(); connect.mockReset(); });

describe('server-assigned attachment order', () => {
  it('serializes concurrent appends after every persisted binding, including disabled skills', async () => {
    const bindings = new Map([[1, 0], [2, 7]]); // skill 2 is disabled and absent from the UI
    let lock = Promise.resolve();
    const releases: ReturnType<typeof vi.fn>[] = [];
    connect.mockImplementation(async () => {
      let unlock: (() => void) | undefined;
      let locked = false;
      const release = vi.fn(); releases.push(release);
      return { release, query: async (sql: string, args: number[]) => {
        if (sql.startsWith('BEGIN')) { expect(sql).toContain('READ COMMITTED'); return { rows: [] }; }
        if (sql.includes('FOR UPDATE')) {
          const previous = lock;
          lock = new Promise<void>(resolve => { unlock = resolve; });
          await previous; locked = true;
          expect(args).toEqual([10]);
          return { rows: [{ id: 10 }] };
        }
        if (sql.startsWith('INSERT INTO agent_skills')) {
          expect(locked).toBe(true);
          expect(sql).toMatch(/MAX\(ord\)/);
          expect(sql).not.toMatch(/JOIN skills|enabled/);
          expect(args).toHaveLength(2);
          const ord = bindings.get(args[1]) ?? Math.max(...bindings.values()) + 1;
          await Promise.resolve(); // expose a missing-lock race between the two calls
          bindings.set(args[1], ord);
          return { rows: [{ ord }] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') { unlock?.(); return { rows: [] }; }
        throw new Error(`Unexpected query: ${sql}`);
      } };
    });
    expect(await Promise.all([attachSkill(10, 3), attachSkill(10, 4)])).toEqual([8, 9]);
    expect(await attachSkill(10, 3)).toBe(8); // duplicate attach does not reorder the prompt
    expect([...bindings.values()]).toEqual([0, 7, 8, 9]);
    expect(releases.every(release => release.mock.calls.length === 1)).toBe(true);
  });
  it('rolls back and releases the connection when attachment fails', async () => {
    const clientQuery = vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 10 }] }).mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    connect.mockResolvedValue({ query: clientQuery, release });
    await expect(attachSkill(10, 3)).rejects.toThrow('insert failed');
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('catalog', () => {
  it.each([false, true])('disabled bindings retain restrictions only when tools were configured: %s', async (configured) => {
    query.mockResolvedValueOnce({ rows: [{
      id: 1, name: 'scoped', tier: 'custom', enabled: true, gateway: 'security', persona: 'Inspect',
      skills: [], tool_policy_configured: configured,
    }] });
    const [agent] = await listAgentsWithSkills({ enabledOnly: true });
    // Pin the emitted SQL boundary: disabling an empty prompt-only skill must not make
    // this hand-computed false fixture true. Disabled nonempty bindings remain joined.
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/bool_or\(jsonb_array_length\(s\.tool_allowlist\) > 0\)/);
    expect(sql).not.toMatch(/LEFT JOIN skills s ON[^\n]*enabled/);
    expect(resolveAgent(agent.name, [agent]).toolAllowlist).toEqual(configured ? [] : undefined);
  });
  it('retains configured tool-policy state when disabled skills leave the active composition', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 1, name: 'scoped', tier: 'custom', enabled: true, skills: [], tool_policy_configured: true,
    }] });
    const [agent] = await listAgentsWithSkills({ enabledOnly: true });
    expect(agent.skills).toEqual([]);
    expect(agent.toolPolicyConfigured).toBe(true);
  });
  it('computeSkillHash is stable and order-independent on tool_allowlist', () => {
    const a = computeSkillHash({ name: 's', description: 'd', instructions: 'i', toolAllowlist: ['x', 'y'] });
    const b = computeSkillHash({ name: 's', description: 'd', instructions: 'i', toolAllowlist: ['y', 'x'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('upsertSkill writes content_hash, tier, disabled-by-default', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const id = await upsertSkill({ name: 's', description: 'd', instructions: 'i', toolAllowlist: [], tier: 'custom', createdBy: 'a@x' });
    expect(id).toBe(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO skills/i);
    expect(sql).toMatch(/ON CONFLICT \(name\) DO UPDATE/i);
    expect(sql).toMatch(/enabled = false/i); // never re-enables on update
    expect(params).toContain('custom');
    expect(params.some((p: string) => /^[a-f0-9]{64}$/.test(p))).toBe(true);
  });

  it('listAgentsWithSkills maps snake_case rows + ordered skills', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 'compliance', description: 'd', persona: 'P', gateway: 'security', tier: 'custom',
        version: 2, enabled: true, routing_keywords: ['cis'],
        skills: [{ name: 'cis', instructions: 'check', content_hash: 'h1', ord: 0, tool_allowlist: [] }] },
    ]});
    const agents = await listAgentsWithSkills({ enabledOnly: true });
    expect(agents[0].name).toBe('compliance');
    expect(agents[0].routingKeywords).toEqual(['cis']);
    expect(agents[0].skills[0].contentHash).toBe('h1');
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE a\.enabled = true/);
  });

  it('writeAudit inserts a row', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await writeAudit({ actor: 'a@x', action: 'upsert', objectType: 'skill', objectId: '1' });
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO customization_audit/i);
  });

  it('upsertSkill persists agent_types + reference_keys (default agent_types=[generic])', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    await upsertSkill({ name: 's', description: 'd', instructions: 'i', toolAllowlist: [], tier: 'custom' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/agent_types/i);
    expect(sql).toMatch(/reference_keys/i);
    expect(params).toContain(JSON.stringify(['generic'])); // default applied
  });

  it('upsertAgent persists agent_type, gateways (defaults to [gateway]) + response_language', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    await upsertAgent({ name: 'devx', description: 'd', persona: 'p', routingKeywords: ['x'], gateway: 'ops', tier: 'custom' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/agent_type/i);
    expect(sql).toMatch(/gateways/i);
    expect(sql).toMatch(/response_language/i);
    expect(params).toContain('generic');               // agent_type default
    expect(params).toContain(JSON.stringify(['ops']));  // gateways default = [gateway]
  });

  it('upsertAgent honors an explicit multi-gateway scope + agent_type', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 8 }] });
    await upsertAgent({ name: 'devops', description: 'd', persona: 'p', routingKeywords: [], gateway: 'ops',
      tier: 'builtin', agentType: 'triage', gateways: ['ops', 'monitoring'] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE agents\.tier = 'custom'/i); // never clobber a built-in via name collision
    expect(params).toContain('triage');
    expect(params).toContain(JSON.stringify(['ops', 'monitoring']));
  });

  it('upsertAgent throws on a built-in name collision (WHERE tier=custom matched nothing)', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // conflict on a builtin row ⇒ no update ⇒ no row returned
    await expect(upsertAgent({ name: 'devops', description: 'd', persona: 'p', routingKeywords: [], gateway: 'ops', tier: 'custom' }))
      .rejects.toThrow(/built-in agent/);
  });

  it('upsertSkill throws on a built-in name collision', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(upsertSkill({ name: 'builtin-pack', description: 'd', instructions: 'i', toolAllowlist: [], tier: 'custom' }))
      .rejects.toThrow(/built-in skill/);
  });

  it('listSkills returns agentTypes + referenceKeys (defaults when null)', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 's1', description: 'd', tier: 'custom', enabled: true, version: 1, content_hash: 'h',
        agent_types: ['triage'], reference_keys: ['s3://k'] },
      { id: 2, name: 's2', description: 'd', tier: 'custom', enabled: false, version: 1, content_hash: 'h2',
        agent_types: null, reference_keys: null },
    ]});
    const skills = await listSkills();
    expect(skills[0].agentTypes).toEqual(['triage']);
    expect(skills[0].referenceKeys).toEqual(['s3://k']);
    expect(skills[1].agentTypes).toEqual(['generic']); // null → default
    expect(skills[1].referenceKeys).toEqual([]);
  });

  it('listAgentsWithSkills returns agentType/gateways/responseLanguage (defaults when absent)', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 'devops', description: 'd', persona: 'P', gateway: 'ops', tier: 'builtin', version: 1,
        enabled: true, routing_keywords: [], agent_type: 'generic', gateways: ['ops', 'monitoring'],
        response_language: 'ko', skills: [] },
    ]});
    const agents = await listAgentsWithSkills();
    expect(agents[0].agentType).toBe('generic');
    expect(agents[0].gateways).toEqual(['ops', 'monitoring']);
    expect(agents[0].responseLanguage).toBe('ko');
  });
});

describe('isCustomAgentEnabled (fail-closed revocation)', () => {
  it('true only for an enabled custom row, scoped by name+tier+enabled', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await isCustomAgentEnabled('my-agent')).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/tier = 'custom'/i);
    expect(sql).toMatch(/enabled = true/i);
    expect(params).toEqual(['my-agent']);
  });

  it('false for a disabled/missing/builtin row (no row returned)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await isCustomAgentEnabled('disabled-or-builtin')).toBe(false);
  });

  it('false (fail-closed) on any query error — deny, never grant', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(isCustomAgentEnabled('x')).resolves.toBe(false);
  });
});
