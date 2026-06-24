import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const getLatestInsight = vi.fn();
const enqueueInsightRefresh = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/insights', () => ({
  getLatestInsight: (...a: unknown[]) => getLatestInsight(...a),
  enqueueInsightRefresh: (...a: unknown[]) => enqueueInsightRefresh(...a),
}));

import { GET } from './route';
import { POST } from './refresh/route';

function req() { return new Request('http://x/api/insights', { headers: { cookie: 'c' } }); }
beforeEach(() => { verifyUser.mockReset(); isAdmin.mockReset(); getLatestInsight.mockReset(); enqueueInsightRefresh.mockReset(); });

describe('GET /api/insights', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });
  it('returns latest insight', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getLatestInsight.mockResolvedValue({ status: 'succeeded', insights: [] });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).insight.status).toBe('succeeded');
  });
});

describe('POST /api/insights/refresh', () => {
  it('403 for non-admin', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' }); isAdmin.mockResolvedValue(false);
    expect((await POST(req())).status).toBe(403);
    expect(enqueueInsightRefresh).not.toHaveBeenCalled();
  });
  it('503 when disabled', async () => {
    verifyUser.mockResolvedValue({ sub: 'a' }); isAdmin.mockResolvedValue(true);
    enqueueInsightRefresh.mockResolvedValue('disabled');
    expect((await POST(req())).status).toBe(503);
  });
  it('202 when queued', async () => {
    verifyUser.mockResolvedValue({ sub: 'a' }); isAdmin.mockResolvedValue(true);
    enqueueInsightRefresh.mockResolvedValue('queued');
    const res = await POST(req());
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('queued');
  });
});
