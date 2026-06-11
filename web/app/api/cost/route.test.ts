import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getMtdCost = vi.fn();
const getCostTrend = vi.fn();
const getMonthlyCost = vi.fn();
const getCostForecast = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({
  getMtdCost: (...a: unknown[]) => getMtdCost(...a),
  getCostTrend: (...a: unknown[]) => getCostTrend(...a),
  getMonthlyCost: (...a: unknown[]) => getMonthlyCost(...a),
  getCostForecast: (...a: unknown[]) => getCostForecast(...a),
}));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/cost', { headers: { cookie } });
beforeEach(() => {
  verifyUser.mockReset(); getMtdCost.mockReset(); getCostTrend.mockReset();
  getMonthlyCost.mockReset(); getCostForecast.mockReset();
  // sensible defaults so older cases don't crash on the new secondary calls
  getMonthlyCost.mockResolvedValue([]); getCostForecast.mockResolvedValue(null);
});

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
  it('200 with monthly + forecast on the happy path', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockResolvedValue({ total: 490.5, currency: 'USD', byService: [] });
    getCostTrend.mockResolvedValue([]);
    getMonthlyCost.mockResolvedValue([{ month: '2026-05', total: 400 }, { month: '2026-06', total: 490.5 }]);
    getCostForecast.mockResolvedValue(120.25);
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.monthly).toEqual([{ month: '2026-05', total: 400 }, { month: '2026-06', total: 490.5 }]);
    expect(body.forecast).toBe(120.25);
  });
  it('200 with secondaries degraded on error (trend [], monthly [], forecast null)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockResolvedValue({ total: 1, currency: 'USD', byService: [] });
    getCostTrend.mockRejectedValue(new Error('no ce perms'));
    getMonthlyCost.mockRejectedValue(new Error('no ce perms'));
    getCostForecast.mockRejectedValue(new Error('insufficient history'));
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trend).toEqual([]);
    expect(body.monthly).toEqual([]);
    expect(body.forecast).toBeNull();
  });
  it('500 on CE error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockRejectedValue(new Error('no ce perms'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
