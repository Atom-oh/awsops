import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getMtdCost = vi.fn();
const getCostTrend = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({
  getMtdCost: (...a: unknown[]) => getMtdCost(...a),
  getCostTrend: (...a: unknown[]) => getCostTrend(...a),
}));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/cost', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); getMtdCost.mockReset(); getCostTrend.mockReset(); });

describe('GET /api/cost', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with cost + trend', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockResolvedValue({ total: 490.5, currency: 'USD', byService: [{ service: 'Amazon RDS', amount: 310.5 }] });
    getCostTrend.mockResolvedValue([{ date: '2026-06-01', amount: 12.3 }]);
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(490.5);
    expect(body.trend[0]).toEqual({ date: '2026-06-01', amount: 12.3 });
  });
  it('200 with trend degraded to [] on trend error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockResolvedValue({ total: 1, currency: 'USD', byService: [] });
    getCostTrend.mockRejectedValue(new Error('no ce perms'));
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).trend).toEqual([]);
  });
  it('500 on CE error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockRejectedValue(new Error('no ce perms'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
