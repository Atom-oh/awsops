import { describe, it, expect, beforeEach, vi } from 'vitest';

// The generate route is now Bedrock-DIRECT (datasource-querygen), not the AgentCore monitoring gateway.
const verifyUser = vi.fn();
const generateQuery = vi.fn();
const listConfiguredSchemas = vi.fn();
const upsertSchema = vi.fn();
const renderSchemaForPrompt = vi.fn();
const getDatasource = vi.fn();
const resolveConnConfig = vi.fn();
const invokeMcpLambdaTool = vi.fn();
const assertDatasourceEndpointAllowed = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/datasource-querygen', () => ({ generateQuery: (...a: unknown[]) => generateQuery(...a) }));
vi.mock('@/lib/datasource-schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/datasource-schema')>()), // keep the REAL prioritizeSchemaForQuery
  listConfiguredSchemas: (...a: unknown[]) => listConfiguredSchemas(...a),
  upsertSchema: (...a: unknown[]) => upsertSchema(...a),
  renderSchemaForPrompt: (...a: unknown[]) => renderSchemaForPrompt(...a),
}));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'self' }));
vi.mock('@/lib/datasources', () => ({
  getDatasource: (...a: unknown[]) => getDatasource(...a),
  resolveConnConfig: (...a: unknown[]) => resolveConnConfig(...a),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a) }));
vi.mock('@/lib/ssrf-guard', () => ({ assertDatasourceEndpointAllowed: (...a: unknown[]) => assertDatasourceEndpointAllowed(...a) }));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/datasources/generate', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
}
const lastGen = () => generateQuery.mock.calls.at(-1)![0] as {
  nl: string;
  lang: string;
  schemaBlock: string;
  isSql: boolean;
  previousQuery?: string;
  validationError?: string;
};

beforeEach(() => {
  for (const m of [verifyUser, generateQuery, listConfiguredSchemas, upsertSchema, renderSchemaForPrompt, getDatasource, resolveConnConfig, invokeMcpLambdaTool, assertDatasourceEndpointAllowed]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  listConfiguredSchemas.mockResolvedValue([]);
  // pass-through renderer: `__block` for assertion convenience; metric/table arrays → a non-empty marker
  renderSchemaForPrompt.mockImplementation((s: unknown) => {
    const o = (s || {}) as { __block?: string; metrics?: unknown[]; tables?: unknown[] };
    if (typeof o.__block === 'string') return o.__block;
    if (Array.isArray(o.metrics) && o.metrics.length) return `M:${o.metrics.join(',')}`;
    if (Array.isArray(o.tables) && o.tables.length) return 'T';
    return '';
  });
  generateQuery.mockResolvedValue('SELECT 1');
});

describe('auth + validation', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus', nl: 'x' }))).status).toBe(401);
  });
  it('400 when nl missing', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    const { POST } = await import('./route');
    expect((await POST(req({ id: 2, nl: '   ' }))).status).toBe(400);
  });
  it('400 unknown instance id', async () => {
    getDatasource.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ id: 999, nl: 'x' }))).status).toBe(400);
  });
  it('requires an exact instance id for Prometheus/Mimir generation', async () => {
    const { POST } = await import('./route');
    const res = await POST(req({ kind: 'prometheus', nl: 'up targets' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/instance id/i);
    expect(generateQuery).not.toHaveBeenCalled();
  });
});

describe('SQL generation (the ClickHouse fix)', () => {
  it('uses the cached schema block and read-only SQL lang for a clickhouse instance', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 2, kind: 'clickhouse', schema: { __block: 'otel_traces(ServiceName String)' }, fetched_at: new Date().toISOString() }]);
    generateQuery.mockResolvedValue('SELECT ServiceName FROM otel_traces');
    const { POST } = await import('./route');
    const res = await POST(req({ id: 2, nl: 'api gateway가 보내는 서비스는' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: 'SELECT ServiceName FROM otel_traces', lang: 'read-only SQL' });
    const g = lastGen();
    expect(g).toMatchObject({ lang: 'read-only SQL', isSql: true, schemaBlock: 'otel_traces(ServiceName String)' });
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled(); // FRESH cache hit → no introspect (sync or background)
  });

  const flush = () => new Promise((r) => setTimeout(r, 30)); // let the fire-and-forget cache-warm run

  it('on cache miss, serves schema-less now + warms the cache in the BACKGROUND (thin-BFF: no inline introspect)', async () => {
    getDatasource.mockResolvedValue({ id: 5, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([]); // connect-time warm never ran / failed
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'logs(Body String)', tables: [] });
    const { POST } = await import('./route');
    const res = await POST(req({ id: 5, nl: 'recent logs' }));
    expect(res.status).toBe(200);
    expect(lastGen().schemaBlock).toBe(''); // schema-less THIS request — the read path does NOT block on introspect
    await flush();
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ kind: 'clickhouse', tool: 'clickhouse_schema' }));
    expect(assertDatasourceEndpointAllowed).toHaveBeenCalledWith('http://ch'); // SSRF guard before introspect
    expect(upsertSchema).toHaveBeenCalled(); // cache warmed for next time
  });

  it('on miss, warms THIS instance in the background — never a same-kind SIBLING schema [10]', async () => {
    getDatasource.mockResolvedValue({ id: 6, kind: 'clickhouse', endpoint: 'http://ch-b', authType: 'none' });
    // a DIFFERENT clickhouse instance (99) is cached, but instance 6 is not
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 99, kind: 'clickhouse', schema: { __block: 'SIBLING(x String)' }, fetched_at: 't' }]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch-b', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'OWN(y String)' });
    const { POST } = await import('./route');
    const res = await POST(req({ id: 6, nl: 'tables' }));
    expect(res.status).toBe(200);
    expect(lastGen().schemaBlock).toBe(''); // NOT the sibling's 'SIBLING(…)' — a sibling is never used for a specific id
    await flush();
    expect(resolveConnConfig).toHaveBeenCalled(); // background warm resolved THIS instance's conn-config
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'clickhouse_schema' }));
  });

  it('background cache-warm falls back to a trimmed write when the schema exceeds the size limit [4]', async () => {
    getDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'X(c String)', tables: [{ name: 'X', columns: [] }] });
    upsertSchema.mockRejectedValueOnce(new Error('introspected schema exceeds size limit')); // full write fails
    upsertSchema.mockResolvedValueOnce(undefined); // trimmed write succeeds
    const { POST } = await import('./route');
    const res = await POST(req({ id: 7, nl: 'tables' }));
    expect(res.status).toBe(200);
    await flush();
    expect(upsertSchema).toHaveBeenCalledTimes(2); // full (failed) → trimmed fallback
  });

  it('502 when the generator throws (e.g. prose-not-SQL guard or Bedrock failure)', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    generateQuery.mockRejectedValue(new Error('could not generate a valid read-only query'));
    const { POST } = await import('./route');
    const res = await POST(req({ id: 2, nl: 'whatever' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/read-only query/);
  });
});

describe('Prometheus metric relevance', () => {
  it('floats NL-relevant metrics to the front before rendering (so the cap keeps them)', async () => {
    getDatasource.mockResolvedValue({ id: 1, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    // relevant metric is LAST (alphabetical), would be dropped by the render cap without prioritization
    const metrics = ['ALERTS', 'aggregator_total', 'alertmanager_alerts', 'kube_pod_container_resource_requests'];
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'prometheus', schema: { metrics }, fetched_at: 't' }]);
    generateQuery.mockResolvedValue('kube_pod_container_resource_requests');
    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: 'pod resource조회' }));
    expect(res.status).toBe(200);
    // renderSchemaForPrompt received the REAL-prioritized schema → pod/resource metric is now first
    const schemaArg = renderSchemaForPrompt.mock.calls.at(-1)![0] as { metrics: string[] };
    expect(schemaArg.metrics[0]).toBe('kube_pod_container_resource_requests');
    expect(lastGen()).toMatchObject({ lang: 'PromQL', isSql: false });
  });

  it('grounds a Korean memory prompt with metric-specific labels', async () => {
    getDatasource.mockResolvedValue({ id: 1, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{
      integrationId: 1,
      kind: 'prometheus',
      schema: {
        metrics: [
          'ALERTS',
          'node_memory_MemAvailable_bytes',
          'node_memory_MemTotal_bytes',
        ],
      },
      fetched_at: new Date().toISOString(),
    }]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://prom', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({
      node_memory_MemAvailable_bytes: { type: 'gauge', labels: ['instance', 'job'] },
      node_memory_MemTotal_bytes: { type: 'gauge', labels: ['instance', 'job'] },
    });
    generateQuery.mockResolvedValue(
      'topk(5, 100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))',
    );

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '메모리 사용률이 높은 인스턴스' }));

    expect(res.status).toBe(200);
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'prometheus',
      tool: 'prometheus_metric_meta',
      args: { metrics: expect.arrayContaining([
        'node_memory_MemAvailable_bytes',
        'node_memory_MemTotal_bytes',
      ]) },
      connConfig: { endpoint: 'http://prom', authType: 'none' },
    }));
    expect((invokeMcpLambdaTool.mock.calls[0][0] as { args: { metrics: string[] } }).args.metrics)
      .toHaveLength(2);
    expect(lastGen().schemaBlock).toContain(
      'node_memory_MemAvailable_bytes (gauge; labels: instance, job)',
    );
  });
});

describe('Prometheus/Mimir live query validation', () => {
  function promFixture() {
    getDatasource.mockResolvedValue({ id: 1, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{
      integrationId: 1,
      kind: 'prometheus',
      schema: { metrics: ['up'] },
      fetched_at: new Date().toISOString(),
    }]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://prom', authType: 'none' });
  }

  it('returns a candidate only after a bounded live validation succeeds', async () => {
    promFixture();
    generateQuery.mockResolvedValue('up');
    invokeMcpLambdaTool.mockImplementation(async ({ tool }: { tool: string }) => (
      tool === 'prometheus_metric_meta' ? {} : { resultType: 'vector', result: [] }
    ));

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '다운된 타깃 찾기' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: 'up', lang: 'PromQL' });
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'prometheus',
      tool: 'prometheus_query',
      args: { query: 'up', timeout: '5s' },
    }));
  });

  it('fails closed when no exact-instance metric grounding is available', async () => {
    getDatasource.mockResolvedValue({ id: 1, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{
      integrationId: 1,
      kind: 'prometheus',
      schema: { labels: ['job'] },
      fetched_at: new Date().toISOString(),
    }]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://prom', authType: 'none' });

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '조회' }));

    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/grounding unavailable/i);
    expect(generateQuery).not.toHaveBeenCalled();
  });

  it('fails closed when requested metric metadata cannot be read', async () => {
    promFixture();
    invokeMcpLambdaTool.mockRejectedValue(new Error('Prometheus HTTP 503: unavailable'));

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '다운된 타깃 찾기' }));

    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/grounding unavailable/i);
    expect(generateQuery).not.toHaveBeenCalled();
  });

  it('self-corrects a query that references no exact-instance grounded metric', async () => {
    promFixture();
    generateQuery.mockResolvedValueOnce('sum(hallucinated_metric)').mockResolvedValueOnce('sum(up)');
    invokeMcpLambdaTool.mockImplementation(async ({ tool }: { tool: string }) => (
      tool === 'prometheus_metric_meta' ? {} : { resultType: 'vector', result: [] }
    ));

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '정상 타깃 수' }));

    expect(res.status).toBe(200);
    expect((await res.json()).query).toBe('sum(up)');
    expect(generateQuery).toHaveBeenCalledTimes(2);
    expect(lastGen().validationError).toMatch(/grounded metric/i);
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'prometheus_query',
      args: expect.objectContaining({ query: 'sum(hallucinated_metric)' }),
    }));
  });

  it('self-corrects once after a conclusive PromQL parse error', async () => {
    promFixture();
    generateQuery.mockResolvedValueOnce('up(').mockResolvedValueOnce('up');
    invokeMcpLambdaTool.mockImplementation(async ({ tool, args }: { tool: string; args?: Record<string, unknown> }) => {
      if (tool === 'prometheus_metric_meta') return {};
      if (args?.query === 'up(') throw new Error('Prometheus query failed (bad_data): parse error');
      return { resultType: 'vector', result: [] };
    });

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '다운된 타깃 찾기' }));

    expect(res.status).toBe(200);
    expect((await res.json()).query).toBe('up');
    expect(generateQuery).toHaveBeenCalledTimes(2);
    expect(lastGen()).toMatchObject({
      previousQuery: 'up(',
      validationError: expect.stringMatching(/parse error/i),
    });
  });

  it('self-corrects a conclusive Prometheus HTTP 422 type error', async () => {
    promFixture();
    generateQuery.mockResolvedValueOnce('topk(5, 1)').mockResolvedValueOnce('topk(5, up)');
    invokeMcpLambdaTool.mockImplementation(async ({ tool, args }: { tool: string; args?: Record<string, unknown> }) => {
      if (tool === 'prometheus_metric_meta') return {};
      if (args?.query === 'topk(5, 1)') {
        throw new Error('Prometheus HTTP 422: expected type instant vector in call to function topk');
      }
      return { resultType: 'vector', result: [] };
    });

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '상위 5개 타깃' }));

    expect(res.status).toBe(200);
    expect((await res.json()).query).toBe('topk(5, up)');
    expect(generateQuery).toHaveBeenCalledTimes(2);
  });

  it('returns 422 when both generated candidates fail syntax validation', async () => {
    promFixture();
    generateQuery.mockResolvedValueOnce('up(').mockResolvedValueOnce('sum(');
    invokeMcpLambdaTool.mockImplementation(async ({ tool }: { tool: string }) => {
      if (tool === 'prometheus_metric_meta') return {};
      throw new Error('Prometheus query failed (bad_data): parse error');
    });

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '다운된 타깃 찾기' }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/validation/i);
    expect(generateQuery).toHaveBeenCalledTimes(2);
  });

  it('returns 503 without spending a correction attempt on a transient connector failure', async () => {
    promFixture();
    generateQuery.mockResolvedValue('up');
    invokeMcpLambdaTool.mockImplementation(async ({ tool }: { tool: string }) => {
      if (tool === 'prometheus_metric_meta') return {};
      throw new Error('Prometheus HTTP 503: unavailable');
    });

    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: '다운된 타깃 찾기' }));

    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/validation unavailable/i);
    expect(generateQuery).toHaveBeenCalledTimes(1);
  });
});

describe('lazy refresh (TTL) [P2]', () => {
  const flush = () => new Promise((r) => setTimeout(r, 25)); // let the fire-and-forget refresh run

  it('refreshes in the background on a STALE cache hit (serves cached now)', async () => {
    getDatasource.mockResolvedValue({ id: 11, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 11, kind: 'prometheus', schema: { __block: 'CACHED', metrics: ['up'] }, fetched_at: '2020-01-01T00:00:00Z' }]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://prom', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'FRESH', metrics: ['up'] });
    generateQuery.mockResolvedValue('up');
    const { POST } = await import('./route');
    const res = await POST(req({ id: 11, nl: 'is it up' }));
    expect(res.status).toBe(200);
    expect(lastGen().schemaBlock).toBe('CACHED'); // served the cached copy immediately
    await flush();
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'prometheus_schema' })); // background refresh fired
  });

  it('does NOT refresh on a FRESH cache hit', async () => {
    getDatasource.mockResolvedValue({ id: 12, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 12, kind: 'prometheus', schema: { __block: 'CACHED', metrics: ['up'] }, fetched_at: new Date().toISOString() }]);
    generateQuery.mockResolvedValue('up');
    const { POST } = await import('./route');
    await POST(req({ id: 12, nl: 'is it up' }));
    await flush();
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled(); // fresh → no introspect
  });
});

describe('non-SQL datasources', () => {
  it('keeps the deprecated slug path for non-PromQL DSLs', async () => {
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'loki', schema: { __block: 'labels: job' }, fetched_at: 't' }]);
    generateQuery.mockResolvedValue('{job=~".+"}');
    const { POST } = await import('./route');
    const res = await POST(req({ slug: 'loki', kind: 'loki', nl: 'recent logs' }));
    expect(res.status).toBe(200);
    expect(lastGen()).toMatchObject({ lang: 'LogQL', isSql: false, schemaBlock: 'labels: job' });
    expect(getDatasource).not.toHaveBeenCalled(); // slug path → no instance fetch / introspect
  });
});
