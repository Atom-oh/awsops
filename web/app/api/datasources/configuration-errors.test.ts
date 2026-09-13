import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ row: vi.fn(), snapshot: vi.fn(), invoke: vi.fn(), cache: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'reader' }) }));
vi.mock('@/lib/admin', () => ({ isAdmin: async () => true }));
vi.mock('@/lib/datasources', async original => ({ ...await original<typeof import('@/lib/datasources')>(), getDatasource: m.row }));
vi.mock('@/lib/integration-credentials', () => ({ getIntegrationCredentialSnapshot: m.snapshot }));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: m.invoke }));
vi.mock('@/lib/datasource-schema', () => ({ upsertSchema: m.cache, listConfiguredSchemas: vi.fn() }));
vi.mock('@/lib/diag-signals', () => ({ enqueueDatasourceIndex: vi.fn() }));
import { POST as query } from './query/route';
import { POST as schema } from '../integrations/schema/route';
const request = () => new Request('http://local/api/datasources', { method: 'POST', body: JSON.stringify({ id: 5, query: 'up' }) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('AURORA_ENDPOINT', 'configured'); });
afterEach(() => vi.unstubAllEnvs());
describe.each([['query', query], ['schema', schema]] as const)('%s connection failures', (_, handler) => {
  it.each([
    ['bearer', {}], [null, {}],
    ['none', { 5: { endpoint: 'https://other.example', org_id: 'tenant-a' } }],
    ['none', { 5: { endpoint: 'https://other.example' } }],
    ['none', { prometheus: { endpoint: 'https://other.example', org_id: 'tenant-a' } }],
  ])('returns configuration guidance for unresolved %s auth', async (authType, snapshot) => {
    m.row.mockResolvedValue({ id: 5, kind: 'prometheus', endpoint: 'https://metrics.example', authType, isDefault: true });
    m.snapshot.mockResolvedValue(snapshot);
    const response = await handler(request());
    expect({ status: response.status, ...await response.json() }).toMatchObject({ status: 400, code: 'configuration' });
    expect(m.invoke).not.toHaveBeenCalled();
    expect(m.cache).not.toHaveBeenCalled();
  });
  it('returns unavailable without disclosing credential-store error text', async () => {
    m.row.mockResolvedValue({ id: 5, kind: 'prometheus' });
    m.snapshot.mockRejectedValue(new Error('store error with secret-value'));
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret-value');
    expect(m.invoke).not.toHaveBeenCalled();
  });
});
