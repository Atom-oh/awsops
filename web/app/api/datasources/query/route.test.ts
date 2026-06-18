import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyUser = vi.fn();
const invokeMcpLambdaTool = vi.fn();
const getDatasource = vi.fn();
const resolveConnConfig = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a) }));
vi.mock('@/lib/datasources', () => ({
  getDatasource: (...a: unknown[]) => getDatasource(...a),
  resolveConnConfig: (...a: unknown[]) => resolveConnConfig(...a),
}));
// NOTE: datasource-render is NOT mocked — the matrix→series normalization is exercised for real.

function req(body: unknown) {
  return new Request('http://x/api/datasources/query', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const m of [verifyUser, invokeMcpLambdaTool, getDatasource, resolveConnConfig]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  invokeMcpLambdaTool.mockResolvedValue({ resultType: 'vector', result: [] });
});

describe('POST /api/datasources/query', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus', query: 'up' }))).status).toBe(401);
  });

  it('by INSTANCE id resolves the row + credential and passes an inline conn-config', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'prometheus', endpoint: 'http://s:9090', authType: 'none', isDefault: false, enabled: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://s:9090', authType: 'none' });
    const { POST } = await import('./route');
    expect((await POST(req({ id: 2, query: 'up' }))).status).toBe(200);
    const call = invokeMcpLambdaTool.mock.calls.at(-1)![0];
    expect(call.kind).toBe('prometheus');
    expect(call.tool).toBe('prometheus_query');
    expect(call.connConfig).toEqual({ endpoint: 'http://s:9090', authType: 'none' });
  });

  it('by slug (deprecated) sends NO inline conn-config → Lambda kind-mirror fallback', async () => {
    const { POST } = await import('./route');
    await POST(req({ slug: 'prometheus', query: 'up' }));
    expect(invokeMcpLambdaTool.mock.calls.at(-1)![0].connConfig).toBeUndefined();
  });

  it('400 on unknown kind / empty query', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'evil', query: 'up' }))).status).toBe(400);
    expect((await POST(req({ slug: 'prometheus', query: '   ' }))).status).toBe(400);
  });

  it('clickhouse maps the query to the `sql` arg (not `query`)', async () => {
    invokeMcpLambdaTool.mockResolvedValue({ rowCount: 0, rows: [], meta: [] });
    const { POST } = await import('./route');
    await POST(req({ slug: 'clickhouse', query: 'SELECT 1' }));
    const call = invokeMcpLambdaTool.mock.calls.at(-1)![0];
    expect(call.tool).toBe('clickhouse_query');
    expect(call.args.sql).toBe('SELECT 1');
    expect(call.args.query).toBeUndefined();
  });

  it('range flag selects *_query_range; tempo always uses tempo_search', async () => {
    const { POST } = await import('./route');
    await POST(req({ slug: 'prometheus', query: 'up', range: true }));
    expect(invokeMcpLambdaTool.mock.calls.at(-1)![0].tool).toBe('prometheus_query_range');
    await POST(req({ slug: 'tempo', query: '{ duration > 1s }', range: true }));
    expect(invokeMcpLambdaTool.mock.calls.at(-1)![0].tool).toBe('tempo_search');
  });

  it('every TOOL value is a read-only tool (no mutating verb reachable)', async () => {
    const { TOOL } = await import('@/lib/datasource-query-tools');
    const tools = Object.values(TOOL).flatMap((t) => [t.instant, t.range].filter(Boolean) as string[]);
    expect(tools.length).toBeGreaterThan(0);
    for (const name of tools) {
      expect(name).toMatch(/_(query|query_range|search)$/);
      expect(name).not.toMatch(/create|put|delete|update|write|insert|drop|alter|set|remove|exec/i);
    }
  });

  it('SSRF-blocks a bad resolved endpoint (400, no invoke)', async () => {
    getDatasource.mockResolvedValue({ id: 3, kind: 'clickhouse', endpoint: 'http://169.254.169.254', authType: 'none', isDefault: false, enabled: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://169.254.169.254', authType: 'none' });
    const { POST } = await import('./route');
    expect((await POST(req({ id: 3, query: 'SELECT 1' }))).status).toBe(400);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('connector error → 502 with a clean message', async () => {
    invokeMcpLambdaTool.mockRejectedValue(new Error('connector prometheus error'));
    const { POST } = await import('./route');
    const res = await POST(req({ slug: 'prometheus', query: 'up' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('prometheus');
  });

  it('normalizes the connector body (matrix → series)', async () => {
    invokeMcpLambdaTool.mockResolvedValue({ resultType: 'matrix', result: [{ metric: { __name__: 'up' }, values: [[1, '1']] }] });
    const { POST } = await import('./route');
    const res = await POST(req({ slug: 'prometheus', query: 'up', range: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).result.shape).toBe('series');
  });
});
