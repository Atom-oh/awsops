import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

const getIntegrationByReceivePath = vi.fn();
const getCredentialById = vi.fn();
const triageAndCreateOrLink = vi.fn();
const enqueueInitialStage = vi.fn();

vi.mock('@/lib/integrations', () => ({ getIntegrationByReceivePath: (...a: unknown[]) => getIntegrationByReceivePath(...a) }));
vi.mock('@/lib/integration-credentials', () => ({ getCredentialById: (...a: unknown[]) => getCredentialById(...a) }));
vi.mock('@/lib/incident', () => ({
  triageAndCreateOrLink: (...a: unknown[]) => triageAndCreateOrLink(...a),
  enqueueInitialStage: (...a: unknown[]) => enqueueInitialStage(...a),
}));

const ROW = {
  id: 4, name: 'my-hook', kind: 'generic_webhook', direction: 'ingress' as const, tier: 'custom' as const,
  enabled: true, receivePath: '/api/integrations/ingress/tok123',
};
const SECRET = 'super-secret-hmac-key';
const ALERT = JSON.stringify({ title: 'HighCPU', severity: 'critical', source: 'generic', message: 'cpu high', labels: { service: 'api', instance: 'i-1' } });

function post(rawBody: string, headers: Record<string, string> = {}) {
  return new Request('http://x/api/integrations/ingress/tok123', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5, 198.51.100.7', ...headers },
    body: rawBody,
  });
}
function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

beforeEach(() => {
  vi.resetModules();
  getIntegrationByReceivePath.mockReset(); getCredentialById.mockReset();
  triageAndCreateOrLink.mockReset(); enqueueInitialStage.mockReset();
  getIntegrationByReceivePath.mockResolvedValue(ROW);
  getCredentialById.mockResolvedValue({ mode: 'hmac', secret: SECRET });
  triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-1' });
  enqueueInitialStage.mockResolvedValue({ jobId: 'job-1' });
  process.env.INCIDENT_LIFECYCLE_ENABLED = 'true';
});

describe('POST /api/integrations/ingress/[token] — flag OFF', () => {
  it('503s and never looks up the integration', async () => {
    process.env.INCIDENT_LIFECYCLE_ENABLED = 'false';
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT) }), { params: { token: 'tok123' } });
    expect(res.status).toBe(503);
    expect(getIntegrationByReceivePath).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/ingress/[token] — lookup', () => {
  it('404 when no integration matches the token', async () => {
    getIntegrationByReceivePath.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(post(ALERT), { params: { token: 'nope' } });
    expect(res.status).toBe(404);
  });
  it('404 when the row is not a generic_webhook kind (e.g. stale/mismatched)', async () => {
    getIntegrationByReceivePath.mockResolvedValue({ ...ROW, kind: 'pagerduty' });
    const { POST } = await import('./route');
    expect((await POST(post(ALERT), { params: { token: 'tok123' } })).status).toBe(404);
  });
  it('503 when the integration is disabled', async () => {
    getIntegrationByReceivePath.mockResolvedValue({ ...ROW, enabled: false });
    const { POST } = await import('./route');
    expect((await POST(post(ALERT), { params: { token: 'tok123' } })).status).toBe(503);
  });
  it('503 when no credential has ever been generated', async () => {
    getCredentialById.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(post(ALERT), { params: { token: 'tok123' } })).status).toBe(503);
  });
});

describe('POST /api/integrations/ingress/[token] — HMAC auth', () => {
  it('401 with no signature header', async () => {
    const { POST } = await import('./route');
    expect((await POST(post(ALERT), { params: { token: 'tok123' } })).status).toBe(401);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });
  it('401 with a wrong signature', async () => {
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT, 'wrong-secret') }), { params: { token: 'tok123' } });
    expect(res.status).toBe(401);
  });
  it('202 + triages on a valid signature', async () => {
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { 'x-webhook-signature': sign(ALERT) }), { params: { token: 'tok123' } });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.new).toBe(1);
    expect(triageAndCreateOrLink).toHaveBeenCalledTimes(1);
    expect(enqueueInitialStage).toHaveBeenCalledWith('inc-1');
  });
});

describe('POST /api/integrations/ingress/[token] — API key (Bearer) auth', () => {
  beforeEach(() => { getCredentialById.mockResolvedValue({ mode: 'api_key', secret: 'the-api-key' }); });

  it('401 with a wrong bearer token', async () => {
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { authorization: 'Bearer wrong' }), { params: { token: 'tok123' } });
    expect(res.status).toBe(401);
  });
  it('202 with the correct bearer token', async () => {
    const { POST } = await import('./route');
    const res = await POST(post(ALERT, { authorization: 'Bearer the-api-key' }), { params: { token: 'tok123' } });
    expect(res.status).toBe(202);
  });
});

describe('POST /api/integrations/ingress/[token] — body handling', () => {
  it('400 on invalid JSON', async () => {
    const { POST } = await import('./route');
    const bad = 'not json';
    const res = await POST(post(bad, { 'x-webhook-signature': sign(bad) }), { params: { token: 'tok123' } });
    expect(res.status).toBe(400);
  });
  it('drops a self-writeback-marked alert without triaging (ADR-034 breaker, same as the shared route)', async () => {
    const selfBody = JSON.stringify({
      title: 'x', severity: 'critical', source: 'generic', message: 'm',
      labels: { CreatedBy: 'AWSops-AIOps' },
    });
    const { POST } = await import('./route');
    const res = await POST(post(selfBody, { 'x-webhook-signature': sign(selfBody) }), { params: { token: 'tok123' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'dropped_self_writeback', dropped: 1 });
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });
});
