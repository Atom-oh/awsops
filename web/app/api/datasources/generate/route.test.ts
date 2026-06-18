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
vi.mock('@/lib/datasource-schema', () => ({
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
const lastGen = () => generateQuery.mock.calls.at(-1)![0] as { nl: string; lang: string; schemaBlock: string; isSql: boolean };

beforeEach(() => {
  for (const m of [verifyUser, generateQuery, listConfiguredSchemas, upsertSchema, renderSchemaForPrompt, getDatasource, resolveConnConfig, invokeMcpLambdaTool, assertDatasourceEndpointAllowed]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  listConfiguredSchemas.mockResolvedValue([]);
  // pass-through renderer: schema objects carry a `__block` string for assertion convenience
  renderSchemaForPrompt.mockImplementation((s: unknown) => (s && typeof s === 'object' && '__block' in (s as object) ? (s as { __block: string }).__block : ''));
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
});

describe('SQL generation (the ClickHouse fix)', () => {
  it('uses the cached schema block and read-only SQL lang for a clickhouse instance', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 2, kind: 'clickhouse', schema: { __block: 'otel_traces(ServiceName String)' }, fetched_at: 't' }]);
    generateQuery.mockResolvedValue('SELECT ServiceName FROM otel_traces');
    const { POST } = await import('./route');
    const res = await POST(req({ id: 2, nl: 'api gateway가 보내는 서비스는' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: 'SELECT ServiceName FROM otel_traces', lang: 'read-only SQL' });
    const g = lastGen();
    expect(g).toMatchObject({ lang: 'read-only SQL', isSql: true, schemaBlock: 'otel_traces(ServiceName String)' });
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled(); // cache hit → no on-demand introspect
  });

  it('on-demand introspects + caches when no schema is cached yet', async () => {
    getDatasource.mockResolvedValue({ id: 5, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([]); // connect-time warm never ran / failed
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'logs(Body String)', tables: [] });
    const { POST } = await import('./route');
    const res = await POST(req({ id: 5, nl: 'recent logs' }));
    expect(res.status).toBe(200);
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ kind: 'clickhouse', tool: 'clickhouse_schema' }));
    expect(assertDatasourceEndpointAllowed).toHaveBeenCalledWith('http://ch'); // SSRF guard before introspect
    expect(upsertSchema).toHaveBeenCalled(); // self-heal the cache
    expect(lastGen().schemaBlock).toBe('logs(Body String)');
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

describe('non-SQL datasources', () => {
  it('marks PromQL as non-SQL (no read-verb guard) for a slug/kind request', async () => {
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'prometheus', schema: { __block: 'metrics: up' }, fetched_at: 't' }]);
    generateQuery.mockResolvedValue('up');
    const { POST } = await import('./route');
    const res = await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: 'is it up' }));
    expect(res.status).toBe(200);
    expect(lastGen()).toMatchObject({ lang: 'PromQL', isSql: false, schemaBlock: 'metrics: up' });
    expect(getDatasource).not.toHaveBeenCalled(); // slug path → no instance fetch / introspect
  });
});

describe('language-aware NL→query prompt (WS-D)', () => {
  const prompt = () =>
    (invokeAgent.mock.calls.at(-1)![0] as { systemPromptOverride?: string }).systemPromptOverride ?? '';

  it('prometheus prompt carries PromQL syntax guidance', async () => {
    invokeAgent.mockResolvedValue('```\nup\n```');
    const { POST } = await import('./route');
    await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: 'cpu' }));
    expect(prompt()).toMatch(/rate\(/);
    expect(prompt()).toMatch(/\[5m\]/);
    expect(prompt()).toMatch(/sum by/);
  });

  it('loki prompt carries LogQL guidance', async () => {
    invokeAgent.mockResolvedValue('```\n{}\n```');
    const { POST } = await import('./route');
    await POST(req({ slug: 'loki', kind: 'loki', nl: 'errors' }));
    expect(prompt()).toMatch(/count_over_time/);
    expect(prompt()).toMatch(/\|~/);
  });

  it('clickhouse prompt keeps the read-only SELECT rule', async () => {
    invokeAgent.mockResolvedValue('```\nSELECT 1\n```');
    const { POST } = await import('./route');
    await POST(req({ slug: 'clickhouse', kind: 'clickhouse', nl: 'rows' }));
    expect(prompt()).toMatch(/SELECT/);
    expect(prompt()).toMatch(/read-only/i);
  });

  it('instructs not to invent names when no schema is available', async () => {
    invokeAgent.mockResolvedValue('```\nup\n```');
    const { POST } = await import('./route');
    await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: 'cpu' }));
    expect(prompt()).toMatch(/do NOT invent/i);
    expect(prompt()).toMatch(/refresh/i);
  });
});
