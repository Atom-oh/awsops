import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/inventory/summary', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/inventory/summary', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 returns byType/byCategory/total', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [
      { resource_type: 'ec2', n: 5 },
      { resource_type: 'lambda', n: 12 },
      { resource_type: 's3', n: 3 },
    ] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    // sorted desc by count
    expect(body.byType[0]).toEqual({ type: 'lambda', label: 'Lambda Functions', count: 12 });
    expect(body.total).toBe(20);
    // ec2+lambda are Compute (17), s3 is Storage & DB (3)
    const compute = body.byCategory.find((c: { group: string }) => c.group === 'Compute');
    expect(compute.count).toBe(17);
    const storage = body.byCategory.find((c: { group: string }) => c.group === 'Storage & DB');
    expect(storage.count).toBe(3);
  });
  it('500 on db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
