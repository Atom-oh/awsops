// Alert webhook API endpoint — receives alerts from external systems
// 알림 웹훅 API 엔드포인트 — 외부 시스템 알림 수신
// ADR-009
//
// Supported sources:
//   - CloudWatch Alarm (via SNS HTTP subscription)
//   - Prometheus Alertmanager (webhook)
//   - Grafana Alerting (webhook contact point)
//   - Generic webhook (custom format)
//
// Security: HMAC-SHA256 verification, rate limiting, replay protection

import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  normalizeAlert,
  detectAlertSource,
} from '@/lib/alert-types';
import type { AlertSource } from '@/lib/app-config';
import {
  isAlertDiagnosisEnabled,
  getAlertSourceConfig,
  getAlertDiagnosisConfig,
} from '@/lib/app-config';
import { ingestAlert } from '@/lib/alert-correlation';
import { ensureAlertDiagnosisStarted } from '@/lib/alert-diagnosis';

// Rate limiting: per-source IP, 60 requests/min
const rateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// HMAC-SHA256 verification
function verifySignature(body: string, signature: string, secret: string): boolean {
  try {
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    const sig = signature.replace(/^sha256=/, '');
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// SNS subscription confirmation
async function confirmSnsSubscription(body: Record<string, unknown>): Promise<NextResponse> {
  const subscribeUrl = body.SubscribeURL as string;
  if (subscribeUrl && typeof subscribeUrl === 'string' && subscribeUrl.startsWith('https://sns.')) {
    try {
      await fetch(subscribeUrl);
      console.log(`[AlertWebhook] SNS subscription confirmed: ${body.TopicArn}`);
      return NextResponse.json({ status: 'subscription_confirmed' });
    } catch (err) {
      console.error('[AlertWebhook] SNS subscription confirmation failed:', err);
    }
  }
  return NextResponse.json({ error: 'Invalid subscription URL' }, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  // Check if alert diagnosis is enabled
  if (!isAlertDiagnosisEnabled()) {
    return NextResponse.json({ error: 'Alert diagnosis is not enabled' }, { status: 503 });
  }

  // Rate limiting
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  // Parse body
  let rawBody: string;
  let body: Record<string, unknown>;
  try {
    rawBody = await request.text();
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Handle SNS subscription confirmation
  if (body.Type === 'SubscriptionConfirmation') {
    return confirmSnsSubscription(body);
  }

  // Detect source
  const sourceHint = request.headers.get('x-alert-source') as AlertSource | null;
  const detectedSource = sourceHint || detectAlertSource(body);

  // Verify HMAC signature if configured for this source
  const sourceConfig = getAlertSourceConfig(detectedSource);
  if (sourceConfig && !sourceConfig.enabled) {
    return NextResponse.json({ error: `Source ${detectedSource} is disabled` }, { status: 403 });
  }

  if (sourceConfig?.secret) {
    const signature = request.headers.get('x-webhook-signature') ||
      request.headers.get('x-hub-signature-256') ||  // GitHub-style
      request.headers.get('x-alertmanager-signature') || '';

    if (!signature || !verifySignature(rawBody, signature, sourceConfig.secret)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  // Replay protection: reject alerts older than 15 minutes
  const config = getAlertDiagnosisConfig();
  const maxAge = (config.deduplicationWindowMinutes || 15) * 60_000;

  // Normalize alerts
  const alerts = normalizeAlert(body, detectedSource);
  if (alerts.length === 0) {
    return NextResponse.json({ error: 'No valid alerts found in payload' }, { status: 400 });
  }

  // Filter out stale alerts
  const now = Date.now();
  const freshAlerts = alerts.filter(a => {
    const alertTime = new Date(a.timestamp).getTime();
    return isNaN(alertTime) || (now - alertTime) < maxAge;
  });

  if (freshAlerts.length === 0) {
    return NextResponse.json({ status: 'skipped', reason: 'all alerts are stale' });
  }

  // Ensure diagnosis handler is registered
  ensureAlertDiagnosisStarted();

  // Ingest each alert into the correlation engine
  let accepted = 0;
  for (const alert of freshAlerts) {
    try {
      ingestAlert(alert);
      accepted++;
    } catch (err) {
      console.error(`[AlertWebhook] Failed to ingest alert ${alert.alertName}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[AlertWebhook] ${detectedSource}: ${accepted}/${alerts.length} alerts accepted from ${ip}`);

  return NextResponse.json({
    status: 'accepted',
    source: detectedSource,
    alertsReceived: alerts.length,
    alertsAccepted: accepted,
  });
}

// GET: Health check + status
export async function GET(): Promise<NextResponse> {
  const enabled = isAlertDiagnosisEnabled();
  const config = getAlertDiagnosisConfig();
  const enabledSources = Object.entries(config.sources || {})
    .filter(([, v]) => v?.enabled)
    .map(([k]) => k);

  return NextResponse.json({
    enabled,
    sources: enabledSources,
    correlationWindowSeconds: config.correlationWindowSeconds || 30,
    deduplicationWindowMinutes: config.deduplicationWindowMinutes || 15,
    minimumSeverity: config.minimumSeverity || 'warning',
  });
}
