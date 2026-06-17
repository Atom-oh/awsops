import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

import { GET } from './route';

beforeEach(() => {
  verifyUser.mockReset(); query.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a' });
  query.mockResolvedValue({ rows: [] });
});

describe('GET /api/graph', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const r = await GET(new Request('http://x/api/graph'));
    expect(r.status).toBe(401);
  });

  it('returns the materialized graph shape', async () => {
    const r = await GET(new Request('http://x/api/graph'));
    const j = await r.json();
    expect(j).toHaveProperty('nodes');
    expect(j).toHaveProperty('edges');
    expect(j).toHaveProperty('captured_at');
  });

  it('?from=&dir=up runs the upstream traversal', async () => {
    query.mockResolvedValue({ rows: [{ id: 'y', depth: 1 }] });
    const r = await GET(new Request('http://x/api/graph?from=cf:D1&dir=up'));
    const j = await r.json();
    expect(j.from).toBe('cf:D1');
    expect(j.dir).toBe('up');
    expect(j.reach[0].id).toBe('y');
    // the traversal SQL was issued with the node id
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE'), ['cf:D1']);
  });
});
