import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const invokeMcpLambdaTool = vi.fn();
const getDatasource = vi.fn();
const getCredentialById = vi.fn();
const getIntegrationCredentialSnapshot = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/datasources', async (original) => ({
  ...await original<typeof import('@/lib/datasources')>(),
  getDatasource: (...a: unknown[]) => getDatasource(...a),
}));
vi.mock('@/lib/integration-credentials', () => ({
  getCredentialById: (...a: unknown[]) => getCredentialById(...a),
  getIntegrationCredentialSnapshot: () => getIntegrationCredentialSnapshot(),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({
  invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a),
  KNOWN_MCP_LAMBDA_KINDS: ['notion', 'clickhouse', 'prometheus', 'loki', 'tempo', 'mimir', 'datadog'],
}));

function req(body: unknown) {
  return new Request('http://x/api/datasources/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' },
    body: JSON.stringify(body),
  });
}
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  getIntegrationCredentialSnapshot.mockReset().mockImplementation(async () => { const blob = await getCredentialById(7); return blob ? { 7: blob } : {}; });
  for (const m of [verifyUser, isAdmin, invokeMcpLambdaTool, getDatasource, getCredentialById]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  isAdmin.mockResolvedValue(true);
  invokeMcpLambdaTool.mockResolvedValue({ ok: true, latency_ms: 42 });
  getDatasource.mockResolvedValue({
    id: 7, kind: 'prometheus', endpoint: 'https://metrics.example/api',
    authType: 'bearer', settings: { timeoutS: 20 },
  });
  getCredentialById.mockResolvedValue({ endpoint: 'https://metrics.example/api', token: 'stored-secret' });
});

describe('POST /api/datasources/test', () => {
  it('tests a partial Datadog rotation using the other key by header name', async () => {
    getDatasource.mockResolvedValue({ id: 7, kind: 'datadog', endpoint: 'https://api.datadoghq.com', authType: 'custom_header', settings: {} });
    getCredentialById.mockResolvedValue({
      endpoint: 'https://api.datadoghq.com',
      headerName: 'DD-APPLICATION-KEY', headerValue: 'old-app',
      headerName2: 'DD-API-KEY', headerValue2: 'old-api',
    });
    const { POST } = await import('./route');
    await POST(req({ id: 7, kind: 'datadog', endpoint: 'https://api.datadoghq.com', creds: { headerName: 'DD-API-KEY', headerValue: 'new-api' } }));
    expect(invokeMcpLambdaTool.mock.calls[0][0].connConfig).toMatchObject({
      headerName: 'DD-API-KEY', headerValue: 'new-api',
      headerName2: 'DD-APPLICATION-KEY', headerValue2: 'old-app',
    });
  });
  it('reuses only the exact id-secret endpoint for migrated rows without endpoint metadata', async () => {
    getDatasource.mockResolvedValue({ id: 7, kind: 'prometheus', endpoint: null, authType: 'bearer', settings: {} });
    const { POST } = await import('./route');
    const response = await POST(req({ id: 7, kind: 'prometheus', endpoint: 'https://metrics.example/api' }));
    expect((await response.json()).ok).toBe(true);
    expect(invokeMcpLambdaTool.mock.calls[0][0].connConfig.token).toBe('stored-secret');
  });
  it('401 unauthenticated / 403 non-admin', async () => {
    verifyUser.mockResolvedValueOnce(null);
    let { POST } = await import('./route');
    expect((await POST(req({ kind: 'prometheus', endpoint: 'http://p:9090' }))).status).toBe(401);
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(false);
    ({ POST } = await import('./route'));
    expect((await POST(req({ kind: 'prometheus', endpoint: 'http://p:9090' }))).status).toBe(403);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it.each([[42, 42], [0, 0], [undefined, 25], [-1, 25], [NaN, 25], [Infinity, 25], ['42', 25]])(
    'probes inline and prefers valid connector latency %s → %s', async (latency_ms, expected) => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(125);
    invokeMcpLambdaTool.mockResolvedValue({ ok: true, latency_ms });
    const { POST } = await import('./route');
    const resp = await POST(req({ kind: 'prometheus', endpoint: 'http://p:9090', authType: 'bearer', creds: { token: 't' } }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, latencyMs: expected });
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(call.tool).toBe('prometheus_health');
    expect(call.connConfig).toEqual({ endpoint: 'http://p:9090', authType: 'bearer', token: 't' });
  });

  it('SSRF-blocks a metadata/loopback endpoint with 400 and no invoke', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'prometheus', endpoint: 'http://169.254.169.254/' }))).status).toBe(400);
    expect((await POST(req({ kind: 'prometheus', endpoint: 'http://0.0.0.0:9090' }))).status).toBe(400);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind and a missing endpoint', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'notion', endpoint: 'http://10.0.0.5' }))).status).toBe(400); // notion is not a datasource kind
    expect((await POST(req({ kind: 'prometheus' }))).status).toBe(400);
  });

  it('returns ok:false (200) on a connector error — never the secret', async () => {
    invokeMcpLambdaTool.mockRejectedValue(new Error('HTTP 401 Unauthorized'));
    const { POST } = await import('./route');
    const resp = await POST(req({ kind: 'clickhouse', endpoint: 'http://10.0.0.5:8123', authType: 'basic', creds: { username: 'u', password: 'supersecret' } }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('supersecret');
  });

  it('tests an existing instance with its stored credential and settings without returning them', async () => {
    const { POST } = await import('./route');
    const resp = await POST(req({ id: 7, kind: 'prometheus', endpoint: 'https://metrics.example/api', authType: 'bearer', creds: {} }));
    expect((await resp.json()).ok).toBe(true);
    expect(getCredentialById).toHaveBeenCalledWith(7);
    expect(invokeMcpLambdaTool.mock.calls[0][0].connConfig).toMatchObject({
      endpoint: 'https://metrics.example/api', token: 'stored-secret', timeoutS: 20,
    });
  });

  it.each(['https://other.example/api', 'https://metrics.example/other', 'http://metrics.example/api'])(
    'does not forward stored credentials to a changed endpoint: %s', async (endpoint) => {
      const { POST } = await import('./route');
      const resp = await POST(req({ id: 7, kind: 'prometheus', endpoint, authType: 'bearer', creds: {} }));
      expect(resp.status).toBe(400);
      expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
    },
  );

  it('does not let creds override the validated endpoint or authentication mode', async () => {
    const { POST } = await import('./route');
    const resp = await POST(req({
      kind: 'prometheus', endpoint: 'https://metrics.example', authType: 'none',
      creds: { endpoint: 'http://169.254.169.254', authType: 'bearer', token: 'unused' },
    }));
    expect(resp.status).toBe(200);
    expect(invokeMcpLambdaTool.mock.calls[0][0].connConfig).toEqual({
      endpoint: 'https://metrics.example', authType: 'none',
    });
  });

  it.each([null, [], { kind: 'prometheus', endpoint: 'https://metrics.example', authType: 'typo' }])(
    'rejects malformed candidates with a controlled error', async (body) => {
      const { POST } = await import('./route');
      expect((await POST(req(body))).status).toBe(400);
      expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
    },
  );

  it('rejects an instance/kind mismatch and missing stored credentials', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ id: 7, kind: 'loki', endpoint: 'https://metrics.example/api' }))).status).toBe(400);
    getCredentialById.mockResolvedValue(null);
    expect((await POST(req({ id: 7, kind: 'prometheus', endpoint: 'https://metrics.example/api', authType: 'bearer' }))).status).toBe(400);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it.each(['HTTP 401', 'Datadog API key validation failed', 'Datadog metric query validation failed'])('classifies %s without disclosing upstream text', async error => {
    const { POST } = await import('./route');
    invokeMcpLambdaTool.mockResolvedValue({ ok: false, error: `${error} echoed supersecret` });
    let resp = await POST(req({ kind: 'prometheus', endpoint: 'https://metrics.example', authType: 'bearer', creds: { token: 'supersecret' } }));
    const body = await resp.json();
    expect(body.code).toBe('authentication');
    expect(JSON.stringify(body)).not.toContain('supersecret');
    invokeMcpLambdaTool.mockRejectedValue(new Error('HTTP 401 echoed stored-secret'));
    resp = await POST(req({ id: 7, kind: 'prometheus', endpoint: 'https://metrics.example/api', authType: 'bearer' }));
    expect(await resp.text()).not.toContain('stored-secret');
  });
});
