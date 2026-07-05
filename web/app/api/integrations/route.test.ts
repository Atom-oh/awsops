import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const query = vi.fn();
const writeAudit = vi.fn();
const validateIntegration = vi.fn();
const assertEgressEndpointAllowed = vi.fn();
const upsertIntegration = vi.fn();
const listIntegrations = vi.fn();
const setIntegrationEnabled = vi.fn();
const deleteIntegration = vi.fn();
const getIntegrationById = vi.fn();
const setIntegrationCredentialById = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'self' }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/catalog', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/integration-validation', () => ({ validateIntegration: (...a: unknown[]) => validateIntegration(...a) }));
vi.mock('@/lib/ssrf-guard', () => ({ assertEgressEndpointAllowed: (...a: unknown[]) => assertEgressEndpointAllowed(...a) }));
vi.mock('@/lib/integrations', () => ({
  upsertIntegration: (...a: unknown[]) => upsertIntegration(...a),
  listIntegrations: (...a: unknown[]) => listIntegrations(...a),
  setIntegrationEnabled: (...a: unknown[]) => setIntegrationEnabled(...a),
  deleteIntegration: (...a: unknown[]) => deleteIntegration(...a),
  getIntegrationById: (...a: unknown[]) => getIntegrationById(...a),
}));
vi.mock('@/lib/integration-credentials', () => ({
  setIntegrationCredentialById: (...a: unknown[]) => setIntegrationCredentialById(...a),
}));

function req(body: unknown, method = 'POST') {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' } };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
  return new Request('http://x/api/integrations', init);
}

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, query, writeAudit, validateIntegration, assertEgressEndpointAllowed, upsertIntegration, listIntegrations, setIntegrationEnabled, deleteIntegration, getIntegrationById, setIntegrationCredentialById]) m.mockReset();
  process.env.AURORA_ENDPOINT = 'aurora.example';
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  isAdmin.mockResolvedValue(true);
  validateIntegration.mockReturnValue({ ok: true, errors: [] });
  query.mockResolvedValue({ rows: [] });          // no agent_spaces opt-in row ⇒ allowPrivate false
  upsertIntegration.mockResolvedValue(9);
});

describe('/api/integrations gate', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({}))).status).toBe(401);
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req({}))).status).toBe(403);
  });
  it('400 when Aurora not configured', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { POST } = await import('./route');
    expect((await POST(req({}))).status).toBe(400);
  });
});

describe('/api/integrations POST', () => {
  it('egress: SSRF-guards with the account allowPrivate then upserts (200)', async () => {
    query.mockResolvedValue({ rows: [{ allow_private_datasource: false }] });
    const { POST } = await import('./route');
    const res = await POST(req({ name: 'grafana-ro', kind: 'grafana', direction: 'egress', endpoint: 'https://g.example', transport: 'api_key' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: 9 });
    expect(assertEgressEndpointAllowed).toHaveBeenCalledWith('https://g.example', { allowPrivate: false });
    expect(writeAudit).toHaveBeenCalled();
  });
  it('egress: 400 when the SSRF guard rejects a private endpoint', async () => {
    assertEgressEndpointAllowed.mockImplementation(() => { throw new Error('endpoint host 10.0.0.5 is a private/metadata address'); });
    const { POST } = await import('./route');
    const res = await POST(req({ name: 'priv', kind: 'grafana', direction: 'egress', endpoint: 'https://10.0.0.5', transport: 'api_key' }));
    expect(res.status).toBe(400);
    expect(upsertIntegration).not.toHaveBeenCalled();
  });
  it('egress: passes allowPrivate=true when the account opted in', async () => {
    query.mockResolvedValue({ rows: [{ allow_private_datasource: true }] });
    const { POST } = await import('./route');
    await POST(req({ name: 'priv-ok', kind: 'grafana', direction: 'egress', endpoint: 'https://10.0.0.5', transport: 'api_key' }));
    expect(assertEgressEndpointAllowed).toHaveBeenCalledWith('https://10.0.0.5', { allowPrivate: true });
  });
  it('ingress: generates + returns a receive_path (no SSRF/endpoint check)', async () => {
    const { POST } = await import('./route');
    const res = await POST(req({ name: 'pd-in', kind: 'pagerduty', direction: 'ingress', authMode: 'vendor_sig', triggerTarget: 'incident' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.receivePath).toMatch(/^\/api\/integrations\/ingress\/[0-9a-f]{32}$/);
    expect(assertEgressEndpointAllowed).not.toHaveBeenCalled();
    expect(upsertIntegration).toHaveBeenCalledWith(expect.objectContaining({ receivePath: body.receivePath, direction: 'ingress' }));
  });
  it('400 on invalid integration', async () => {
    validateIntegration.mockReturnValue({ ok: false, errors: ['bad'] });
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'x' }))).status).toBe(400);
  });
  it('409 on a built-in name collision', async () => {
    upsertIntegration.mockRejectedValue(new Error('name conflicts with a built-in integration'));
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'slack', kind: 'slack', direction: 'egress', endpoint: 'https://s', transport: 'api_key' }))).status).toBe(409);
  });
});

describe('/api/integrations GET + PUT', () => {
  it('GET lists integrations', async () => {
    listIntegrations.mockResolvedValue([{ id: 1, name: 'g' }]);
    const { GET } = await import('./route');
    const res = await GET(req({}, 'GET'));
    expect((await res.json()).integrations).toHaveLength(1);
  });
  it('PUT enable toggles (custom-only) + audits', async () => {
    const { PUT } = await import('./route');
    const res = await PUT(req({ op: 'enable', id: 3 }, 'PUT'));
    expect(res.status).toBe(200);
    expect(setIntegrationEnabled).toHaveBeenCalledWith(3, true);
  });
});

describe('/api/integrations PUT op:generate-credential (Phase 2 / W4)', () => {
  const genericWebhookRow = {
    id: 4, name: 'my-hook', kind: 'generic_webhook', direction: 'ingress', tier: 'custom',
    enabled: false, authMode: 'hmac', receivePath: '/api/integrations/ingress/abc',
  };

  it('mints an HMAC secret, stores it by id, returns it once', async () => {
    getIntegrationById.mockResolvedValue(genericWebhookRow);
    const { PUT } = await import('./route');
    const res = await PUT(req({ op: 'generate-credential', id: 4 }, 'PUT'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.receivePath).toBe('/api/integrations/ingress/abc');
    expect(body.authMode).toBe('hmac');
    expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(setIntegrationCredentialById).toHaveBeenCalledWith(4, { mode: 'hmac', secret: body.secret });
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'generate-credential', objectId: '4' }));
  });

  it('mints an api_key secret when the row is configured for api_key', async () => {
    getIntegrationById.mockResolvedValue({ ...genericWebhookRow, authMode: 'api_key' });
    const { PUT } = await import('./route');
    const res = await PUT(req({ op: 'generate-credential', id: 4 }, 'PUT'));
    const body = await res.json();
    expect(body.authMode).toBe('api_key');
    expect(setIntegrationCredentialById).toHaveBeenCalledWith(4, { mode: 'api_key', secret: body.secret });
  });

  it('400 when the row is not a custom generic_webhook ingress integration', async () => {
    getIntegrationById.mockResolvedValue({ ...genericWebhookRow, kind: 'pagerduty' });
    const { PUT } = await import('./route');
    const res = await PUT(req({ op: 'generate-credential', id: 4 }, 'PUT'));
    expect(res.status).toBe(400);
    expect(setIntegrationCredentialById).not.toHaveBeenCalled();
  });

  it('400 when the row does not exist', async () => {
    getIntegrationById.mockResolvedValue(null);
    const { PUT } = await import('./route');
    expect((await PUT(req({ op: 'generate-credential', id: 999 }, 'PUT'))).status).toBe(400);
  });

  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { PUT } = await import('./route');
    expect((await PUT(req({ op: 'generate-credential', id: 4 }, 'PUT'))).status).toBe(403);
    expect(getIntegrationById).not.toHaveBeenCalled();
  });
});

describe('/api/integrations DELETE', () => {
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { DELETE } = await import('./route');
    expect((await DELETE(req({ id: 3 }, 'DELETE'))).status).toBe(403);
    expect(deleteIntegration).not.toHaveBeenCalled();
  });
  it('400 when id is not an integer', async () => {
    const { DELETE } = await import('./route');
    expect((await DELETE(req({ id: 'nope' }, 'DELETE'))).status).toBe(400);
  });
  it('deletes a custom integration + audits', async () => {
    const { DELETE } = await import('./route');
    const res = await DELETE(req({ id: 4 }, 'DELETE'));
    expect(res.status).toBe(200);
    expect(deleteIntegration).toHaveBeenCalledWith(4);
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', objectType: 'integration', objectId: '4' }));
  });
});
