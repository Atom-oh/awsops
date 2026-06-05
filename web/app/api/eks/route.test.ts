import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const listClusters = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ listClusters: (...a: unknown[]) => listClusters(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/eks', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); listClusters.mockReset(); });

describe('GET /api/eks', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with clusters', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockResolvedValue([{ name: 'c1', status: 'ACTIVE', version: '1.30', endpoint: 'e', createdAt: '' }]);
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).clusters[0].name).toBe('c1');
  });
  it('500 on SDK error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockRejectedValue(new Error('denied'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
