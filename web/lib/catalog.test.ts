// web/lib/catalog.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));

import { computeSkillHash, upsertSkill, listAgentsWithSkills, writeAudit, isCustomAgentEnabled } from './catalog';

beforeEach(() => query.mockReset());

describe('catalog', () => {
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
