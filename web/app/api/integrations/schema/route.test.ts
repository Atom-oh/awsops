import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn(); const isAdmin = vi.fn();
const invokeConnectorTool = vi.fn(); const upsertSchema = vi.fn(); const listConfiguredSchemas = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'acct-1' }));
vi.mock('@/lib/connector-invoke', () => ({ invokeConnectorTool: (...a: unknown[]) => invokeConnectorTool(...a) }));
vi.mock('@/lib/datasource-schema', () => ({
  upsertSchema: (...a: unknown[]) => upsertSchema(...a),
  listConfiguredSchemas: (...a: unknown[]) => listConfiguredSchemas(...a),
}));
function req(body: unknown, method = 'POST') {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' } };
  if (method !== 'GET') init.body = JSON.stringify(body);
  return new Request('http://x/api/integrations/schema', init);
}
beforeEach(() => {
  for (const m of [verifyUser, isAdmin, invokeConnectorTool, upsertSchema, listConfiguredSchemas]) m.mockReset();
  process.env.AURORA_ENDPOINT = 'aurora'; verifyUser.mockResolvedValue({ email: 'a@x' }); isAdmin.mockResolvedValue(true);
});

describe('/api/integrations/schema', () => {
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus' }))).status).toBe(403);
    expect(invokeConnectorTool).not.toHaveBeenCalled();
  });
  it('POST introspects + upserts under server accountId; returns summary (counts only)', async () => {
    invokeConnectorTool.mockResolvedValue({ metrics: ['up', 'down'], labels: ['job'] });
    const { POST } = await import('./route');
    const resp = await POST(req({ slug: 'prometheus' }));
    expect(resp.status).toBe(200);
    expect(invokeConnectorTool).toHaveBeenCalledWith('prometheus', 'prometheus_schema', {});
    expect(upsertSchema).toHaveBeenCalledWith('acct-1', 'prometheus', 'prometheus', { metrics: ['up', 'down'], labels: ['job'] });
    const body = await resp.json();
    expect(body.summary).toEqual({ metrics: 2, labels: 1 });
    expect(JSON.stringify(body)).not.toContain('"up"'); // values not leaked, only counts
  });
  it('400 unknown slug', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'evil' }))).status).toBe(400);
  });
  it('GET returns cached summaries', async () => {
    listConfiguredSchemas.mockResolvedValue([{ slug: 'loki', kind: 'loki', schema: { labels: ['a', 'b'] }, fetched_at: 't' }]);
    const { GET } = await import('./route');
    const body = await (await GET(req(undefined, 'GET'))).json();
    expect(body.schemas[0]).toEqual({ slug: 'loki', kind: 'loki', fetched_at: 't', summary: { labels: 2 } });
  });
});
