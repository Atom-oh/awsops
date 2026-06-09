import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const upsertSkill = vi.fn();
const upsertAgent = vi.fn();
const writeAudit = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/catalog', () => ({
  upsertSkill: (...a: unknown[]) => upsertSkill(...a),
  upsertAgent: (...a: unknown[]) => upsertAgent(...a),
  attachSkill: vi.fn(), setEnabled: vi.fn(),
  listAgentsWithSkills: vi.fn(async () => []), listSkills: vi.fn(async () => []),
  writeAudit: (...a: unknown[]) => writeAudit(...a),
}));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}
beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); upsertSkill.mockReset(); upsertAgent.mockReset(); writeAudit.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a', email: 'admin@x', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
  process.env.AURORA_ENDPOINT = 'h';
});

describe('POST /api/customization', () => {
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
