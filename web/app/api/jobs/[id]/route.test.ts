import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/jobs/id', { headers: { cookie } });
const ID = '11111111-1111-1111-1111-111111111111';
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

// pentest-remediation P1-review (MAJOR-2): this route previously had no auth check at all —
// anyone with a job UUID could read worker_jobs.result regardless of revocation status.
describe('GET /api/jobs/[id]', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req(), { params: { id: ID } });
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it('400 on a malformed id (checked only after auth)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const res = await GET(req(), { params: { id: 'not-a-uuid' } });
    expect(res.status).toBe(400);
  });
  it('200 with the job row when authenticated', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ job_id: ID, type: 'noop', status: 'succeeded' }] });
    const { GET } = await import('./route');
    const res = await GET(req(), { params: { id: ID } });
    expect(res.status).toBe(200);
    expect((await res.json()).job_id).toBe(ID);
  });
});
