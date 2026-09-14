import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const upsertSkill = vi.fn();
const upsertAgent = vi.fn();
const writeAudit = vi.fn();
const getAgentSpace = vi.fn();
const upsertAgentSpace = vi.fn();
const attachSkill = vi.fn();
const listAgentsWithSkills = vi.fn();
const listSkills = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/catalog', () => ({
  upsertSkill: (...a: unknown[]) => upsertSkill(...a),
  upsertAgent: (...a: unknown[]) => upsertAgent(...a),
  attachSkill: (...a: unknown[]) => attachSkill(...a), setEnabled: vi.fn(),
  listAgentsWithSkills: (...a: unknown[]) => listAgentsWithSkills(...a),
  listSkills: (...a: unknown[]) => listSkills(...a),
  writeAudit: (...a: unknown[]) => writeAudit(...a),
}));
vi.mock('@/lib/agent-space', () => ({
  getAgentSpace: (...a: unknown[]) => getAgentSpace(...a),
  upsertAgentSpace: (...a: unknown[]) => upsertAgentSpace(...a),
}));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'acct-123' }));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}
function putReq(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization', { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}
function getReq(cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization', { method: 'GET', headers: { cookie } });
}
beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); upsertSkill.mockReset(); upsertAgent.mockReset(); writeAudit.mockReset();
  getAgentSpace.mockReset(); upsertAgentSpace.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a', email: 'admin@x', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
  getAgentSpace.mockResolvedValue(null);
  attachSkill.mockReset().mockResolvedValue(8);
  listAgentsWithSkills.mockReset().mockResolvedValue([{ id: 1, tier: 'custom', skills: [] }]);
  listSkills.mockReset().mockResolvedValue([{ id: 2, enabled: true }]);
  process.env.AURORA_ENDPOINT = 'h';
});

describe('POST /api/customization', () => {
  it.each(['observability', 'auto', 'code'])('rejects reserved names before a catalog write: %s', async (name) => {
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'agent', name, description: 'd', gateway: 'ops', routingKeywords: [] }))).status).toBe(400);
    expect(upsertAgent).not.toHaveBeenCalled();
  });
  it.each([null, [], { kind: 'skill', description: 42 }, { kind: 'agent', persona: {} }])('returns 400 for malformed registration: %j', async (body) => {
    const { POST } = await import('./route');
    expect((await POST(req(body))).status).toBe(400);
    expect(upsertSkill).not.toHaveBeenCalled();
    expect(upsertAgent).not.toHaveBeenCalled();
  });
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'skill' }))).status).toBe(401);
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'skill', name: 'cis', description: 'd', instructions: 'i', toolAllowlist: [] }))).status).toBe(403);
  });
  it('400 invalid skill', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'skill', name: 'Bad Name', description: 'd', instructions: 'i', toolAllowlist: [] }))).status).toBe(400);
  });
  it('creates a valid skill (disabled-by-default) + audits', async () => {
    upsertSkill.mockResolvedValue(7);
    const { POST } = await import('./route');
    const res = await POST(req({ kind: 'skill', name: 'cis-pack', description: 'd', instructions: 'i', toolAllowlist: [] }));
    expect(res.status).toBe(200);
    expect(upsertSkill).toHaveBeenCalledWith(expect.objectContaining({ tier: 'custom', createdBy: 'admin@x' }));
    expect(writeAudit).toHaveBeenCalled();
  });
});

describe('PUT /api/customization attachment', () => {
  it.each([null, [], { op: 'attach', agentId: -1, skillId: 2 }, { op: 'attach', agentId: 1, skillId: 'bad' }])('rejects malformed attachment: %j', async (body) => {
    const { PUT } = await import('./route');
    expect((await PUT(putReq(body))).status).toBe(400);
    expect(attachSkill).not.toHaveBeenCalled();
  });
  it('does not allow attachment to a built-in agent', async () => {
    listAgentsWithSkills.mockResolvedValue([{ id: 1, tier: 'builtin', skills: [] }]);
    const { PUT } = await import('./route');
    expect((await PUT(putReq({ op: 'attach', agentId: 1, skillId: 2 }))).status).toBe(403);
    expect(attachSkill).not.toHaveBeenCalled();
  });
  it('reports a missing or disabled skill instead of claiming attachment succeeded', async () => {
    const { PUT } = await import('./route');
    listSkills.mockResolvedValue([]);
    expect((await PUT(putReq({ op: 'attach', agentId: 1, skillId: 2 }))).status).toBe(404);
    listSkills.mockResolvedValue([{ id: 2, enabled: false }]);
    expect((await PUT(putReq({ op: 'attach', agentId: 1, skillId: 2 }))).status).toBe(409);
    expect(attachSkill).not.toHaveBeenCalled();
  });
  it('ignores client order, returns the server order, and preserves the admin gate', async () => {
    const { PUT } = await import('./route');
    isAdmin.mockResolvedValue(false);
    expect((await PUT(putReq({ op: 'attach', agentId: 1, skillId: 2, ord: 3 }))).status).toBe(403);
    expect(attachSkill).not.toHaveBeenCalled();
    isAdmin.mockResolvedValue(true);
    const res = await PUT(putReq({ op: 'attach', agentId: 1, skillId: 2, ord: 3 }));
    expect(await res.json()).toEqual({ ok: true, ord: 8 });
    expect(attachSkill).toHaveBeenCalledWith(1, 2);
  });
});

describe('GET /api/customization', () => {
  it('returns 503 when Agent Space policy cannot be read', async () => {
    getAgentSpace.mockRejectedValue(new Error('Agent Space policy unavailable'));
    const { GET } = await import('./route');
    expect((await GET(getReq())).status).toBe(503);
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    expect((await GET(getReq())).status).toBe(403);
  });
  it('returns accountId + space (null ⇒ Phase-1 global mode) alongside agents/skills', async () => {
    getAgentSpace.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe('acct-123');
    expect(body.space).toBeNull();
    expect(body).toHaveProperty('agents');
    expect(body).toHaveProperty('skills');
    expect(getAgentSpace).toHaveBeenCalledWith('acct-123');
  });
  it('surfaces an existing space', async () => {
    getAgentSpace.mockResolvedValue({ accountId: 'acct-123', enabledAgentIds: [1], enabledSkillIds: [2], toolAllowlist: ['t'], version: 3 });
    const { GET } = await import('./route');
    const body = await (await GET(getReq())).json();
    expect(body.space.version).toBe(3);
  });
});

describe('PUT /api/customization (op:space)', () => {
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { PUT } = await import('./route');
    expect((await PUT(putReq({ op: 'space', enabledAgentIds: [], enabledSkillIds: [], toolAllowlist: [] }))).status).toBe(403);
    expect(upsertAgentSpace).not.toHaveBeenCalled();
  });
  it('admin op:space calls upsertAgentSpace for the current account and returns the version', async () => {
    upsertAgentSpace.mockResolvedValue({ accountId: 'acct-123', enabledAgentIds: [1, 2], enabledSkillIds: [3], toolAllowlist: ['x'], version: 5 });
    const { PUT } = await import('./route');
    const res = await PUT(putReq({ op: 'space', enabledAgentIds: [1, 2], enabledSkillIds: [3], toolAllowlist: ['x'] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 5 });
    expect(upsertAgentSpace).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acct-123', enabledAgentIds: [1, 2], enabledSkillIds: [3], toolAllowlist: ['x'], actor: 'admin@x',
    }));
  });
  it('coerces ids to finite numbers and allowlist to strings', async () => {
    upsertAgentSpace.mockResolvedValue({ accountId: 'acct-123', enabledAgentIds: [], enabledSkillIds: [], toolAllowlist: [], version: 1 });
    const { PUT } = await import('./route');
    await PUT(putReq({ op: 'space', enabledAgentIds: ['1', 'nan', 4], enabledSkillIds: 'bad', toolAllowlist: [7, 'tool'] }));
    expect(upsertAgentSpace).toHaveBeenCalledWith(expect.objectContaining({
      enabledAgentIds: [1, 4], enabledSkillIds: [], toolAllowlist: ['7', 'tool'],
    }));
  });
});
