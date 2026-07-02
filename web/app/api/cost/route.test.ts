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

describe('GET /api/cost — account scoping', () => {
  const reqU = (url: string, cookie = 'awsops_token=t') => new Request(url, { headers: { cookie } });
  beforeEach(() => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockResolvedValue({ total: 1, currency: 'USD', byService: [] });
    getCostTrend.mockResolvedValue([]);
  });
  it('default → host (cost fns called with undefined account)', async () => {
    const { GET } = await import('./route');
    const res = await GET(reqU('http://x/api/cost'));
    expect(res.status).toBe(200);
    expect(getMtdCost).toHaveBeenCalledWith(undefined);
    expect((await res.json()).account).toBe('self');
  });
  it('?account=<id> → that account', async () => {
    const { GET } = await import('./route');
    const res = await GET(reqU('http://x/api/cost?account=210987654321'));
    expect(getMtdCost).toHaveBeenCalledWith('210987654321');
    expect(getMonthlyCost).toHaveBeenCalledWith(6, '210987654321');
    expect((await res.json()).account).toBe('210987654321');
  });
  it('?account=__all__ → 400 (client aggregates)', async () => {
    const { GET } = await import('./route');
    const res = await GET(reqU('http://x/api/cost?account=__all__'));
    expect(res.status).toBe(400);
    expect(getMtdCost).not.toHaveBeenCalled();
  });
});

describe('GET /api/cost — months period filter', () => {
  const reqU = (url: string, cookie = 'awsops_token=t') => new Request(url, { headers: { cookie } });
  beforeEach(() => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockResolvedValue({ total: 1, currency: 'USD', byService: [] });
    getCostTrend.mockResolvedValue([]);
  });
  it('default (no months param) → 6', async () => {
    const { GET } = await import('./route');
    await GET(reqU('http://x/api/cost'));
    expect(getMonthlyCost).toHaveBeenCalledWith(6, undefined);
  });
  it('?months=12 → 12', async () => {
    const { GET } = await import('./route');
    await GET(reqU('http://x/api/cost?months=12'));
    expect(getMonthlyCost).toHaveBeenCalledWith(12, undefined);
  });
  it('?months=1 → 1', async () => {
    const { GET } = await import('./route');
    await GET(reqU('http://x/api/cost?months=1'));
    expect(getMonthlyCost).toHaveBeenCalledWith(1, undefined);
  });
  it('invalid ?months= → falls back to 6', async () => {
    const { GET } = await import('./route');
    await GET(reqU('http://x/api/cost?months=99'));
    expect(getMonthlyCost).toHaveBeenCalledWith(6, undefined);
  });
});
