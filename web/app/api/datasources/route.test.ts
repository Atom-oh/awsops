import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listDatasources = vi.fn();
const getIntegrationCredentialSnapshot = vi.fn();
const deleteDatasource = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/datasources', () => ({
  listDatasources: (...a: unknown[]) => listDatasources(...a),
  deleteDatasource: (...a: unknown[]) => deleteDatasource(...a),
}));
vi.mock('@/lib/integration-credentials', () => ({ getIntegrationCredentialSnapshot: (...a: unknown[]) => getIntegrationCredentialSnapshot(...a) }));

const get = () => new Request('http://x/api/datasources', { headers: { cookie: 'awsops_token=t' } });
const del = () => new Request('http://x/api/datasources/5', { method: 'DELETE', headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, listDatasources, getIntegrationCredentialSnapshot, deleteDatasource]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  isAdmin.mockResolvedValue(true);
  listDatasources.mockResolvedValue([
    { id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, enabled: true },
    { id: 2, name: 'stg-prom', kind: 'prometheus', endpoint: 'http://s', authType: 'basic', isDefault: false, enabled: true },
  ]);
  getIntegrationCredentialSnapshot.mockResolvedValue({ 2: { endpoint: 'http://s', username: 'u', password: 'not-returned' } });
  deleteDatasource.mockResolvedValue(undefined);
});

describe('GET /api/datasources (list instances)', () => {
  it('projects mirror-only and own-id migrated states with one snapshot and no secret values', async () => {
    listDatasources.mockResolvedValue([
      { id: 7, name: 'default', kind: 'prometheus', endpoint: 'https://p/tenant', authType: null, isDefault: true },
      { id: 8, name: 'migrated', kind: 'prometheus', endpoint: null, authType: null, isDefault: false },
    ]);
    getIntegrationCredentialSnapshot.mockResolvedValue({ prometheus: { endpoint: 'https://p/tenant', token: 'mirror-secret' },
      8: { endpoint: 'https://own/tenant', token: 'own-secret' } });
    const { GET } = await import('./route');
    const body = await (await GET(get())).json();
    expect(body.datasources[0]).toMatchObject({ configurationStatus: 'mirror_only', authType: 'bearer', connected: true });
    expect(body.datasources[1]).toMatchObject({ configurationStatus: 'stored', endpoint: 'https://own/tenant', authType: 'bearer' });
    expect(JSON.stringify(body)).not.toMatch(/mirror-secret|own-secret/);
    expect(getIntegrationCredentialSnapshot).toHaveBeenCalledOnce();
  });
  it('counts an id-keyed migrated configuration without claiming a live connection', async () => {
    getIntegrationCredentialSnapshot.mockResolvedValue({ 2: { endpoint: 'http://s', token: 'not-returned' } });
    listDatasources.mockResolvedValue([{ id: 2, name: 'migrated', kind: 'prometheus', endpoint: null, authType: 'bearer', isDefault: true }]);
    const { GET } = await import('./route');
    expect((await (await GET(get())).json()).datasources[0]).toMatchObject({ connected: true, configurationStatus: 'stored' });
  });
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(get())).status).toBe(401);
  });
  it('returns instances with isDefault + connected, no credentials (read = any authed user)', async () => {
    const { GET } = await import('./route');
    const resp = await GET(get());
    expect(resp.status).toBe(200);
    const { datasources } = await resp.json();
    expect(datasources).toHaveLength(2);
    // admin (default mock): the registered URL is included (v1 parity for managers)
    expect(datasources[0]).toMatchObject({ id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, connected: true });
    expect(datasources[1].connected).toBe(true); // id '2' has a credential
  });

  it('omits endpoint (connection detail) for non-admin readers', async () => {
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    const resp = await GET(get());
    const { datasources } = await resp.json();
    expect(JSON.stringify(datasources)).not.toContain('endpoint'); // never leak connection detail to read-only users
  });
  it('degrades to [] (200) when the data layer throws', async () => {
    listDatasources.mockRejectedValue(new Error('aurora down'));
    const { GET } = await import('./route');
    const resp = await GET(get());
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ datasources: [], available: false });
  });
  it('does not mark an authenticated default as configured without an instance credential', async () => {
    listDatasources.mockResolvedValue([{ id: 1, name: 'p', kind: 'prometheus', endpoint: 'https://p', authType: 'bearer', isDefault: true }]);
    const { GET } = await import('./route');
    const { datasources } = await (await GET(get())).json();
    expect(datasources[0].connected).toBe(false);
    expect(datasources[0].configurationStatus).toBe('missing');
  });
});

describe('DELETE /api/datasources/[id]', () => {
  it('admin-only', async () => {
    isAdmin.mockResolvedValue(false);
    const { DELETE } = await import('./[id]/route');
    expect((await DELETE(del(), { params: { id: '5' } })).status).toBe(403);
    expect(deleteDatasource).not.toHaveBeenCalled();
  });
  it('deletes and returns ok', async () => {
    const { DELETE } = await import('./[id]/route');
    const resp = await DELETE(del(), { params: { id: '5' } });
    expect(resp.status).toBe(200);
    expect(deleteDatasource).toHaveBeenCalledWith(5);
  });
});
