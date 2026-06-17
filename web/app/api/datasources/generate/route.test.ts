import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyUser = vi.fn();
const invokeAgent = vi.fn();
const listConfiguredSchemas = vi.fn();
const getDatasource = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/agentcore', () => ({ invokeAgent: (...a: unknown[]) => invokeAgent(...a) }));
vi.mock('@/lib/datasource-schema', () => ({ listConfiguredSchemas: (...a: unknown[]) => listConfiguredSchemas(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'self' }));
vi.mock('@/lib/datasources', () => ({ getDatasource: (...a: unknown[]) => getDatasource(...a) }));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/datasources/generate', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  verifyUser.mockReset(); invokeAgent.mockReset(); listConfiguredSchemas.mockReset(); getDatasource.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  listConfiguredSchemas.mockResolvedValue([{ slug: 'prometheus', kind: 'prometheus', schema: { metrics: ['up'], labels: ['job'] }, fetched_at: 't' }]);
});

describe('instance id resolution', () => {
  it('resolves the kind from the instance id (no connector invoke)', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'loki', endpoint: 'http://l', authType: 'none', isDefault: false, enabled: true });
    invokeAgent.mockResolvedValue('```\n{job="x"}\n```');
    const { POST } = await import('./route');
    const res = await POST(req({ id: 2, nl: 'errors' }));
    expect(res.status).toBe(200);
    expect((await res.json()).lang).toBe('LogQL');
  });
  it('400 when the instance id does not exist', async () => {
    getDatasource.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ id: 999, nl: 'x' }))).status).toBe(400);
  });
});

describe('POST /api/datasources/generate', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: 'cpu' }))).status).toBe(401);
  });

  it('400 on empty nl', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: '  ' }))).status).toBe(400);
  });

  it('400 on unknown slug', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'evil', kind: 'x', nl: 'cpu' }))).status).toBe(400);
  });

  it('extracts the first fenced code block out of prose', async () => {
    invokeAgent.mockResolvedValue('Sure, here is the query:\n```promql\nrate(node_cpu_seconds_total[5m])\n```\nHope that helps!');
    const { POST } = await import('./route');
    const res = await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: 'cpu rate' }));
    expect(res.status).toBe(200);
    expect((await res.json()).query).toBe('rate(node_cpu_seconds_total[5m])');
  });

  it('falls back to the trimmed whole text when there is no fence', async () => {
    invokeAgent.mockResolvedValue('  up{job="api"}  ');
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: 'is api up' })).then((r) => r.json())).query).toBe('up{job="api"}');
  });

  it('passes a query-only system prompt + the cached schema as extraContext', async () => {
    invokeAgent.mockResolvedValue('```\nup\n```');
    const { POST } = await import('./route');
    await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: 'up?' }));
    const arg = invokeAgent.mock.calls.at(-1)![0] as { gateway: string; systemPromptOverride?: string; extraContext?: string };
    expect(arg.gateway).toBe('monitoring');
    expect(arg.systemPromptOverride).toMatch(/PromQL/);
    expect(arg.extraContext).toContain('up'); // the cached metric name is in context
  });
});
