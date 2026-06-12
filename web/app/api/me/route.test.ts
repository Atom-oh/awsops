import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/me', { headers: { cookie } });
beforeEach(() => {
  verifyUser.mockReset();
});

describe('GET /api/me', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with identity', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1', email: 'admin@awsops.io', groups: ['admins'] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sub: 'u1', email: 'admin@awsops.io', groups: ['admins'] });
  });
  it('200 with empty groups when absent', async () => {
    verifyUser.mockResolvedValue({ sub: 'u2', email: 'x@y.z' });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).groups).toEqual([]);
  });
});
