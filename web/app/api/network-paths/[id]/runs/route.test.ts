import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const createRun = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/network-path', async () => {
  const actual = await vi.importActual<typeof import('@/lib/network-path')>('@/lib/network-path');
  return { ...actual, createRun: (...a: unknown[]) => createRun(...a) };
});

const params = { id: 'chk-1' };
const req = () =>
  new Request('http://x/api/network-paths/chk-1/runs', { method: 'POST', headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  verifyUser.mockReset();
  createRun.mockReset();
  process.env.NETWORK_PATH_CHECK_ENABLED = 'true';
});

describe('POST /api/network-paths/[id]/runs', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(401);
    expect(createRun).not.toHaveBeenCalled();
  });

  it('503 unconfigured when the feature flag is off (fail closed)', async () => {
    delete process.env.NETWORK_PATH_CHECK_ENABLED;
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(503);
    expect(createRun).not.toHaveBeenCalled();
  });

  it('404 when the check does not exist or is deleted', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { NotFoundError } = await import('@/lib/network-path');
    createRun.mockRejectedValue(new NotFoundError());
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(404);
  });

  it('202 with the run when a viewer (not the creator) triggers it — any authorized viewer may run', async () => {
    verifyUser.mockResolvedValue({ sub: 'viewer-not-creator' });
    createRun.mockResolvedValue({ id: 'run-1', status: 'queued' });
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.run.id).toBe('run-1');
  });
});
