import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const createRun = vi.fn();
const getCheck = vi.fn();
const listRunsForCheck = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/network-path', async () => {
  const actual = await vi.importActual<typeof import('@/lib/network-path')>('@/lib/network-path');
  return {
    ...actual,
    createRun: (...a: unknown[]) => createRun(...a),
    getCheck: (...a: unknown[]) => getCheck(...a),
    listRunsForCheck: (...a: unknown[]) => listRunsForCheck(...a),
  };
});

const params = { id: 'chk-1' };
const req = () =>
  new Request('http://x/api/network-paths/chk-1/runs', { method: 'POST', headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  verifyUser.mockReset();
  createRun.mockReset();
  getCheck.mockReset();
  listRunsForCheck.mockReset();
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

describe('GET /api/network-paths/[id]/runs', () => {
  const getReq = () => new Request('http://x/api/network-paths/chk-1/runs', { headers: { cookie: 'awsops_token=t' } });

  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(401);
  });

  it('404 when the check does not exist', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    getCheck.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(404);
    expect(listRunsForCheck).not.toHaveBeenCalled();
  });

  it('200 with run history — visible even for a soft-deleted check', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    getCheck.mockResolvedValue({ id: 'chk-1', deleted_at: '2026-08-01T00:00:00Z' });
    listRunsForCheck.mockResolvedValue([{ id: 'run-1' }, { id: 'run-2' }]);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
  });
});
