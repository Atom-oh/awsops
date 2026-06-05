import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getMtdCost = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ getMtdCost: (...a: unknown[]) => getMtdCost(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/cost', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); getMtdCost.mockReset(); });

describe('GET /api/cost', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with cost', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockResolvedValue({ total: 490.5, currency: 'USD', byService: [{ service: 'Amazon RDS', amount: 310.5 }] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(490.5);
  });
  it('500 on CE error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockRejectedValue(new Error('no ce perms'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
