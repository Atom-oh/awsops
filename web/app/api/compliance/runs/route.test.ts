import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const isAdmin = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a), identity: (u: any) => u.email || u.sub }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = () => new Request('http://x/api/compliance/runs', { headers: { cookie: 'awsops_token=t' } });
beforeEach(() => { verifyUser.mockReset(); isAdmin.mockReset(); query.mockReset(); isAdmin.mockResolvedValue(false); });

describe('GET /api/compliance/runs', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req() as any)).status).toBe(401);
  });
  it('200 returns recent runs, scoped to the caller for a non-admin (pentest-remediation P2-1)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [{ id: 2, benchmark: 'cis_v300', status: 'succeeded', pass_rate: 80 }] });
    const { GET } = await import('./route');
    const res = await GET(req() as any);
    expect(res.status).toBe(200);
    expect((await res.json()).runs[0]).toMatchObject({ id: 2, benchmark: 'cis_v300' });
    expect(query.mock.calls[0][0]).toMatch(/WHERE requested_by = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['u']);
  });
  it('200 returns the unfiltered query for an admin', async () => {
    verifyUser.mockResolvedValue({ sub: 'admin-u' });
    isAdmin.mockResolvedValue(true);
    query.mockResolvedValueOnce({ rows: [] });
    const { GET } = await import('./route');
    await GET(req() as any);
    expect(query.mock.calls[0][0]).not.toMatch(/WHERE requested_by/);
  });
  it('500 on db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req() as any)).status).toBe(500);
  });
});
