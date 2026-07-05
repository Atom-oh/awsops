import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  classifyEnvelope,
  isTopicAllowed,
  verifyBearer,
  verifyHmac,
  resolveSourceHint,
  checkRateLimit,
  extractClientIp,
} from './incident-ingress-auth';

describe('checkRateLimit (per-caller map, 60/min)', () => {
  it('allows the first 60 requests from an IP then rejects the 61st', () => {
    const map = new Map<string, { count: number; resetAt: number }>();
    for (let i = 0; i < 60; i++) expect(checkRateLimit(map, '1.2.3.4')).toBe(true);
    expect(checkRateLimit(map, '1.2.3.4')).toBe(false);
  });
  it('tracks each IP independently', () => {
    const map = new Map<string, { count: number; resetAt: number }>();
    for (let i = 0; i < 60; i++) checkRateLimit(map, '1.1.1.1');
    expect(checkRateLimit(map, '1.1.1.1')).toBe(false);
    expect(checkRateLimit(map, '2.2.2.2')).toBe(true);
  });
});

describe('extractClientIp (second-to-last hop behind CloudFront+ALB)', () => {
  it('picks the second-to-last IP when 2+ are forwarded', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.7' } });
    expect(extractClientIp(req)).toBe('203.0.113.5');
  });
  it('falls back to the single IP or "unknown"', () => {
    expect(extractClientIp(new Request('http://x', { headers: { 'x-forwarded-for': '9.9.9.9' } }))).toBe('9.9.9.9');
    expect(extractClientIp(new Request('http://x'))).toBe('unknown');
  });
});

describe('classifyEnvelope (body.Type only — never headers)', () => {
  it('SNS for Notification/SubscriptionConfirmation/UnsubscribeConfirmation', () => {
    for (const t of ['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']) {
      expect(classifyEnvelope({ Type: t })).toBe('sns');
    }
  });
  it('direct for alertmanager/grafana/anything else', () => {
    expect(classifyEnvelope({ alerts: [], receiver: 'r', groupLabels: {} })).toBe('direct');
    expect(classifyEnvelope({})).toBe('direct');
  });
});

describe('isTopicAllowed (source_allowlist JSONB, fail-closed)', () => {
  const arn = 'arn:aws:sns:ap-northeast-2:123456789012:alarms';
  it('true only when arn is in an enabled ingress cloudwatch_sns row source_allowlist', async () => {
    const q = async () => [{ source_allowlist: ['arn:other', arn] }];
    expect(await isTopicAllowed(arn, q)).toBe(true);
  });
  it('false when no row / empty allowlist / arn absent', async () => {
    expect(await isTopicAllowed(arn, async () => [])).toBe(false);
    expect(await isTopicAllowed(arn, async () => [{ source_allowlist: [] }])).toBe(false);
    expect(await isTopicAllowed(arn, async () => [{ source_allowlist: ['arn:nope'] }])).toBe(false);
  });
  it('false (fail-closed) when the query throws', async () => {
    expect(await isTopicAllowed(arn, async () => { throw new Error('db'); })).toBe(false);
  });
});

describe('verifyBearer (length-safe, active/standby)', () => {
  it('accepts active or standby token, rejects wrong / absent / no-secrets', () => {
    expect(verifyBearer('Bearer good', ['good', 'old']).ok).toBe(true);
    expect(verifyBearer('Bearer old', ['good', 'old']).ok).toBe(true);
    expect(verifyBearer('Bearer nope', ['good', 'old']).ok).toBe(false);
    expect(verifyBearer('', ['good']).ok).toBe(false);
    expect(verifyBearer('Bearer good', []).ok).toBe(false);
    expect(verifyBearer('Bearer good', [undefined, undefined]).ok).toBe(false);
  });
  it('does not throw on tokens of differing length (no timingSafeEqual length crash)', () => {
    expect(() => verifyBearer('Bearer short', ['a-much-longer-secret-token'])).not.toThrow();
    expect(verifyBearer('Bearer short', ['a-much-longer-secret-token']).ok).toBe(false);
  });
});

describe('verifyHmac (moved from route; active/standby)', () => {
  const body = '{"alerts":[]}';
  const sig = (s: string) => 'sha256=' + createHmac('sha256', s).update(body).digest('hex');
  it('accepts active and standby, rejects bad / no-secret', () => {
    expect(verifyHmac(body, sig('act'), ['act', 'std']).ok).toBe(true);
    expect(verifyHmac(body, sig('std'), ['act', 'std']).matched).toBe('standby');
    expect(verifyHmac(body, sig('wrong'), ['act']).ok).toBe(false);
    expect(verifyHmac(body, 'sha256=zzz', [undefined]).ok).toBe(false);
  });
});

describe('resolveSourceHint (post-auth; never used for auth)', () => {
  it('forces cloudwatch for an SNS envelope', () => {
    expect(resolveSourceHint({ Type: 'Notification', Message: '{}', TopicArn: 't' }, 'alertmanager')).toBe('cloudwatch');
  });
  it('honors a header hint only if it is a valid AlertSource, else detects from body', () => {
    expect(resolveSourceHint({ alerts: [], receiver: 'r', groupLabels: {} }, 'alertmanager')).toBe('alertmanager');
    // junk header → fall back to detectAlertSource (alertmanager-shaped body)
    expect(resolveSourceHint({ alerts: [], receiver: 'r', groupLabels: {} }, 'evil; rm -rf')).toBe('alertmanager');
  });
});
