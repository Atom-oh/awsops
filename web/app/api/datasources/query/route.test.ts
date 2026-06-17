import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyUser = vi.fn();
const invokeConnectorTool = vi.fn();
const getConfiguredSlugs = vi.fn();
const listConfiguredSchemas = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/connector-invoke', () => ({ invokeConnectorTool: (...a: unknown[]) => invokeConnectorTool(...a) }));
vi.mock('@/lib/integration-credentials', () => ({
  getConfiguredSlugs: (...a: unknown[]) => getConfiguredSlugs(...a),
  KNOWN_CONNECTOR_SLUGS: ['notion', 'clickhouse', 'prometheus', 'loki', 'tempo', 'mimir'],
}));
vi.mock('@/lib/datasource-schema', () => ({ listConfiguredSchemas: (...a: unknown[]) => listConfiguredSchemas(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'self' }));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/datasources/query', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
}
const getReq = (cookie = 'awsops_token=t') => new Request('http://x/api/datasources', { headers: { cookie } });

beforeEach(() => {
  verifyUser.mockReset(); invokeConnectorTool.mockReset(); getConfiguredSlugs.mockReset(); listConfiguredSchemas.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  invokeConnectorTool.mockResolvedValue({ resultType: 'vector', result: [] });
  getConfiguredSlugs.mockResolvedValue(['prometheus', 'clickhouse', 'notion']);
  listConfiguredSchemas.mockResolvedValue([{ slug: 'prometheus', kind: 'prometheus', schema: {}, fetched_at: 't' }]);
});

describe('POST /api/datasources/query', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus', query: 'up' }))).status).toBe(401);
  });

  it('400 on unknown slug', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'evil', query: 'up' }))).status).toBe(400);
  });

  it('400 on empty query', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus', query: '   ' }))).status).toBe(400);
  });

  it('clickhouse maps the query to the `sql` arg (not `query`)', async () => {
    invokeConnectorTool.mockResolvedValue({ rowCount: 0, rows: [], meta: [] });
    const { POST } = await import('./route');
    await POST(req({ slug: 'clickhouse', query: 'SELECT 1' }));
    const [slug, tool, args] = invokeConnectorTool.mock.calls.at(-1)!;
    expect(slug).toBe('clickhouse');
    expect(tool).toBe('clickhouse_query');
    expect((args as Record<string, unknown>).sql).toBe('SELECT 1');
    expect((args as Record<string, unknown>).query).toBeUndefined();
  });

  it('range flag selects *_query_range for prometheus', async () => {
    invokeConnectorTool.mockResolvedValue({ resultType: 'matrix', result: [] });
    const { POST } = await import('./route');
    await POST(req({ slug: 'prometheus', query: 'up', range: true }));
    expect(invokeConnectorTool.mock.calls.at(-1)![1]).toBe('prometheus_query_range');
    await POST(req({ slug: 'prometheus', query: 'up', range: false }));
    expect(invokeConnectorTool.mock.calls.at(-1)![1]).toBe('prometheus_query');
  });

  it('tempo always uses tempo_search (no range tool exists)', async () => {
    invokeConnectorTool.mockResolvedValue({ traces: [] });
    const { POST } = await import('./route');
    await POST(req({ slug: 'tempo', query: '{ duration > 1s }', range: true }));
    expect(invokeConnectorTool.mock.calls.at(-1)![1]).toBe('tempo_search');
  });

  it('every TOOL value is a read-only tool (no mutating verb reachable)', async () => {
    const mod = await import('./route');
    const tools = Object.values(mod.TOOL).flatMap((t) => [t.instant, t.range].filter(Boolean) as string[]);
    expect(tools.length).toBeGreaterThan(0);
    for (const name of tools) {
      expect(name).toMatch(/_(query|query_range|search)$/);
      expect(name).not.toMatch(/create|put|delete|update|write|insert|drop|alter|set|remove|exec/i);
    }
  });

  it('connector error → 502 with a clean message', async () => {
    invokeConnectorTool.mockRejectedValue(new Error('connector prometheus error'));
    const { POST } = await import('./route');
    const res = await POST(req({ slug: 'prometheus', query: 'up' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('prometheus');
  });

  it('normalizes the connector body (matrix → series)', async () => {
    invokeConnectorTool.mockResolvedValue({ resultType: 'matrix', result: [{ metric: { __name__: 'up' }, values: [[1, '1']] }] });
    const { POST } = await import('./route');
    const res = await POST(req({ slug: 'prometheus', query: 'up', range: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).result.shape).toBe('series');
  });
});

describe('GET /api/datasources', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('../route');
    expect((await GET(getReq())).status).toBe(401);
  });

  it('lists configured QUERYABLE datasources with hasSchema, excludes notion', async () => {
    const { GET } = await import('../route');
    const res = await GET(getReq());
    const body = await res.json();
    const slugs = body.datasources.map((d: { slug: string }) => d.slug);
    expect(slugs).toContain('prometheus');
    expect(slugs).toContain('clickhouse');
    expect(slugs).not.toContain('notion'); // not a query datasource
    const prom = body.datasources.find((d: { slug: string }) => d.slug === 'prometheus');
    expect(prom.hasSchema).toBe(true);
    expect(body.datasources.find((d: { slug: string }) => d.slug === 'clickhouse').hasSchema).toBe(false);
  });
});
