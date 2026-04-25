// Unit tests for alert-webhook/route.ts — rate limiting, HMAC verification, SNS confirmation
// ADR-009

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// Mock alert-knowledge (used by GET handler's dynamic import)
vi.mock('@/lib/alert-knowledge', () => ({
  getAlertStats: vi.fn().mockResolvedValue({
    totalIncidents: 5,
    bySeverity: { critical: 3, warning: 2 },
    byCategory: { capacity: 4, configuration: 1 },
    topAlertNames: [{ name: 'HighCPU', count: 3 }],
    topServices: [{ service: 'api-server', count: 3 }],
    avgProcessingTimeMs: 4500,
    dateRange: { from: '2026-04-01', to: '2026-04-16' },
  }),
}));

// Mock app-config
vi.mock('@/lib/app-config', () => ({
  isAlertDiagnosisEnabled: vi.fn(() => true),
  getAlertSourceConfig: vi.fn((source: string) => {
    if (source === 'alertmanager') return { enabled: true, secret: 'test-secret-123' };
    if (source === 'cloudwatch') return { enabled: true };
    if (source === 'grafana') return { enabled: true };
    if (source === 'generic') return { enabled: true };
    return undefined;
  }),
  getAlertDiagnosisConfig: vi.fn(() => ({
    enabled: true,
    sources: {
      alertmanager: { enabled: true, secret: 'test-secret-123' },
      cloudwatch: { enabled: true },
      grafana: { enabled: true },
      generic: { enabled: true },
    },
    correlationWindowSeconds: 30,
    deduplicationWindowMinutes: 15,
    minimumSeverity: 'warning',
  })),
}));

// Mock correlation engine
vi.mock('@/lib/alert-correlation', () => ({
  ingestAlert: vi.fn(),
  getActiveIncidents: vi.fn(() => []),
}));

// Mock diagnosis
vi.mock('@/lib/alert-diagnosis', () => ({
  ensureAlertDiagnosisStarted: vi.fn(),
}));

// Mock alert-types — use real normalizers but wrap for spying
const actualTypes = await vi.importActual<typeof import('@/lib/alert-types')>('@/lib/alert-types');
vi.mock('@/lib/alert-types', async () => {
  const actual = await vi.importActual<typeof import('@/lib/alert-types')>('@/lib/alert-types');
  return {
    ...actual,
    normalizeAlert: vi.fn(actual.normalizeAlert),
    detectAlertSource: vi.fn(actual.detectAlertSource),
  };
});

import { POST, GET } from '@/app/api/alert-webhook/route';
import { ingestAlert } from '@/lib/alert-correlation';
import { isAlertDiagnosisEnabled, getAlertSourceConfig } from '@/lib/app-config';

// --- Helpers ---

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  const bodyStr = JSON.stringify(body);
  return new Request('http://localhost:3000/awsops/api/alert-webhook', {
    method: 'POST',
    body: bodyStr,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.50, 10.0.1.100',
      ...headers,
    },
  });
}

function hmacSign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('alert-webhook route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAlertDiagnosisEnabled).mockReturnValue(true);
  });

  // ===== Disabled state =====

  describe('disabled state', () => {
    it('returns 503 when alert diagnosis is disabled', async () => {
      vi.mocked(isAlertDiagnosisEnabled).mockReturnValue(false);

      const req = makeRequest({ title: 'Test', severity: 'warning' });
      const res = await POST(req);

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toContain('not enabled');
    });
  });

  // ===== JSON parsing =====

  describe('JSON parsing', () => {
    it('returns 400 for invalid JSON', async () => {
      const req = new Request('http://localhost:3000/awsops/api/alert-webhook', {
        method: 'POST',
        body: 'not-json-{{{',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '1.2.3.4',
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Invalid JSON');
    });
  });

  // ===== SNS Subscription Confirmation =====

  describe('SNS subscription confirmation', () => {
    it('confirms valid AWS SNS subscription URL', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('ok'));

      const req = makeRequest({
        Type: 'SubscriptionConfirmation',
        TopicArn: 'arn:aws:sns:ap-northeast-2:111111111111:test',
        SubscribeURL: 'https://sns.ap-northeast-2.amazonaws.com/confirm?token=abc',
      });

      const res = await POST(req);
      const json = await res.json();

      expect(json.status).toBe('subscription_confirmed');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://sns.ap-northeast-2.amazonaws.com/confirm?token=abc',
      );
      fetchSpy.mockRestore();
    });

    it('rejects invalid (non-AWS) subscription URL', async () => {
      const req = makeRequest({
        Type: 'SubscriptionConfirmation',
        SubscribeURL: 'https://evil.example.com/steal-data',
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Invalid subscription URL');
    });
  });

  // ===== HMAC signature verification =====

  describe('HMAC signature verification', () => {
    it('accepts valid HMAC signature', async () => {
      const body = {
        receiver: 'awsops',
        status: 'firing',
        groupLabels: {},
        alerts: [{
          status: 'firing',
          labels: { alertname: 'HMACTest', severity: 'warning' },
          annotations: { summary: 'Test' },
          startsAt: new Date().toISOString(),
        }],
      };
      const bodyStr = JSON.stringify(body);
      const sig = hmacSign(bodyStr, 'test-secret-123');

      const req = new Request('http://localhost:3000/awsops/api/alert-webhook', {
        method: 'POST',
        body: bodyStr,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.51',
          'x-webhook-signature': sig,
        },
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.status).toBe('accepted');
    });

    it('rejects invalid HMAC signature', async () => {
      const body = {
        receiver: 'awsops',
        groupLabels: {},
        alerts: [{
          status: 'firing',
          labels: { alertname: 'BadSig', severity: 'warning' },
          annotations: {},
          startsAt: new Date().toISOString(),
        }],
      };
      const bodyStr = JSON.stringify(body);

      const req = new Request('http://localhost:3000/awsops/api/alert-webhook', {
        method: 'POST',
        body: bodyStr,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.52',
          'x-webhook-signature': 'deadbeefdeadbeef',
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Invalid signature');
    });
  });

  // ===== Alert ingestion =====

  describe('alert ingestion', () => {
    it('ingests valid Alertmanager payload (without signature when no secret configured)', async () => {
      // Reconfigure: no secret for alertmanager
      vi.mocked(getAlertSourceConfig).mockReturnValue({ enabled: true });

      const body = {
        receiver: 'awsops',
        groupLabels: {},
        alerts: [{
          status: 'firing',
          labels: { alertname: 'TestIngest', severity: 'critical' },
          annotations: { summary: 'Test' },
          startsAt: new Date().toISOString(),
        }],
      };

      const req = makeRequest(body);
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.status).toBe('accepted');
      expect(json.alertsReceived).toBe(1);
      expect(json.alertsAccepted).toBe(1);
      expect(ingestAlert).toHaveBeenCalled();
    });

    it('returns 400 when no valid alerts in CloudWatch payload with malformed Message', async () => {
      vi.mocked(getAlertSourceConfig).mockReturnValue({ enabled: true });

      // CloudWatch source hint + invalid Message JSON → normalizeCloudWatch returns null → empty
      const req = makeRequest(
        { Type: 'Notification', TopicArn: 'arn:aws:sns:us-east-1:111:test', Message: '{{{bad' },
        { 'x-alert-source': 'cloudwatch' },
      );
      const res = await POST(req);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('No valid alerts');
    });

    it('skips stale alerts (>15 min old)', async () => {
      vi.mocked(getAlertSourceConfig).mockReturnValue({ enabled: true });

      const staleTime = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min ago
      const body = {
        title: 'StaleAlert',
        severity: 'warning',
        status: 'firing',
        timestamp: staleTime,
        labels: {},
      };

      const req = makeRequest(body);
      const res = await POST(req);
      const json = await res.json();

      expect(json.status).toBe('skipped');
      expect(json.reason).toContain('stale');
    });

    it('accepts fresh generic alerts', async () => {
      vi.mocked(getAlertSourceConfig).mockReturnValue({ enabled: true });

      const body = {
        title: 'FreshAlert',
        severity: 'warning',
        status: 'firing',
        message: 'Something happened',
        timestamp: new Date().toISOString(),
        labels: { host: 'web-01' },
      };

      const req = makeRequest(body);
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.alertsAccepted).toBe(1);
    });
  });

  // ===== Source detection via header =====

  describe('source detection', () => {
    it('respects x-alert-source header', async () => {
      vi.mocked(getAlertSourceConfig).mockReturnValue({ enabled: true });

      const body = {
        title: 'HeaderSource',
        severity: 'warning',
        timestamp: new Date().toISOString(),
      };

      const req = makeRequest(body, { 'x-alert-source': 'generic' });
      const res = await POST(req);
      const json = await res.json();

      expect(json.source).toBe('generic');
    });
  });

  // ===== Disabled source =====

  describe('disabled source', () => {
    it('returns 403 for disabled source', async () => {
      vi.mocked(getAlertSourceConfig).mockReturnValue({ enabled: false });

      const req = makeRequest({ title: 'Disabled', severity: 'warning', timestamp: new Date().toISOString() });
      const res = await POST(req);

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('disabled');
    });
  });

  // ===== GET health check =====

  describe('GET health check', () => {
    it('returns health/config info', async () => {
      const req = new Request('http://localhost:3000/awsops/api/alert-webhook');
      const res = await GET(req);
      const json = await res.json();

      expect(json.enabled).toBe(true);
      expect(json.correlationWindowSeconds).toBe(30);
      expect(json.deduplicationWindowMinutes).toBe(15);
      expect(json.minimumSeverity).toBe('warning');
    });
  });
});
