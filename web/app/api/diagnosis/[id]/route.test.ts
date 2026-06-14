import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ verifyUser: vi.fn() }));
vi.mock('@/lib/diagnosis', () => ({
  getReport: vi.fn(async (id: number) =>
    id === 1 ? { id: 1, tier: 'mid', status: 'succeeded', artifact_uri: null } : null,
  ),
}));

import { verifyUser } from '@/lib/auth';
import { GET } from './route';

const req = () => ({ headers: { get: () => 'cookie' } } as unknown as Request);
beforeEach(() => vi.clearAllMocks());

describe('GET /api/diagnosis/[id]', () => {
  it('401 when unauthenticated', async () => {
    (verifyUser as any).mockResolvedValue(null);
    const r = await GET(req(), { params: { id: '1' } });
    expect(r.status).toBe(401);
  });
  it('404 for missing', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u' });
    const r = await GET(req(), { params: { id: '999' } });
    expect(r.status).toBe(404);
  });
  it('returns the report', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u' });
    const r = await GET(req(), { params: { id: '1' } });
    expect(r.status).toBe(200);
    expect((await r.json()).report.id).toBe(1);
  });
});
