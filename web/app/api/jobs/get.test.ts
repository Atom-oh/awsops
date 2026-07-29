import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const isAdmin = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/jobs', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); isAdmin.mockReset(); query.mockReset(); isAdmin.mockResolvedValue(false); });

describe('GET /api/jobs', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with jobs list, filtered to the caller (pentest-remediation P0-1)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ job_id: 'j1', type: 'noop', status: 'succeeded', runtime: 'lambda', error: null, created_at: 't', updated_at: 't' }] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).jobs[0].job_id).toBe('j1');
    // non-admin caller: query must be scoped by requested_by, not the unfiltered ORDER BY-only form.
    expect(query.mock.calls[0][0]).toMatch(/WHERE requested_by = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['u']);
  });
  it('admin sees the unfiltered query', async () => {
    verifyUser.mockResolvedValue({ sub: 'admin-u' });
    isAdmin.mockResolvedValue(true);
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req());
    expect(query.mock.calls[0][0]).not.toMatch(/WHERE requested_by/);
  });
});
