import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const readResources = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/inventory', () => ({ readResources: (...a: unknown[]) => readResources(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/inventory/ec2', { headers: { cookie } });
const ctx = { params: { type: 'ec2' } };
beforeEach(() => { verifyUser.mockReset(); readResources.mockReset(); });

describe('GET /api/inventory/[type]', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req(), ctx)).status).toBe(401);
  });
  it('200 with rows+run', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    readResources.mockResolvedValue({ rows: [{ resource_id: 'i-1' }], run: { status: 'succeeded' } });
    const { GET } = await import('./route');
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).rows[0].resource_id).toBe('i-1');
  });
});
