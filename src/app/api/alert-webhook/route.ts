// Alert webhook API endpoint — VPC-internal sources only (ADR-009)
// 알림 웹훅 API 엔드포인트 — VPC 내부 소스 전용 (ADR-009)
//
// This endpoint is for alert sources that can reach ALB directly within the VPC,
// bypassing CloudFront + Cognito Lambda@Edge authentication.
// 이 엔드포인트는 CloudFront + Cognito Lambda@Edge 인증을 우회하여 VPC 내에서
// ALB에 직접 접근 가능한 알림 소스 전용.
//
// For CloudWatch Alarms (external/AWS-native):
//   Use SNS → SQS → alert-sqs-poller.ts (primary path)
//   CloudFront Lambda@Edge blocks unauthenticated SNS HTTP requests.
//
// Supported sources (VPC-internal):
//   - Prometheus Alertmanager (webhook)
//   - Grafana Alerting (webhook contact point)
//   - Generic webhook (custom format)
//   - CloudWatch SNS (only if ALB is reachable without CloudFront, e.g., testing)
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
import { ingestAlert, getActiveIncidents } from '@/lib/alert-correlation';
import { ensureAlertDiagnosisStarted } from '@/lib/alert-diagnosis';

// Rate limiting: per-source IP, 60 requests/min
const rateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_ENTRIES = 10_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  // Prune expired entries when map grows too large
  if (rateLimitMap.size > MAX_RATE_ENTRIES) {
    Array.from(rateLimitMap.entries()).forEach(([key, entry]) => {
      if (now > entry.resetAt) rateLimitMap.delete(key);
    });
  }
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// Extract client IP: use second-to-last from x-forwarded-for (behind CloudFront + ALB)
function extractClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean);
  // CloudFront appends client IP, ALB appends CF IP. Second-to-last is real client.
  return ips.length >= 2 ? ips[ips.length - 2] : ips[0] || 'unknown';
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

// SNS subscription confirmation — validate URL is genuinely AWS before fetching
const SNS_URL_PATTERN = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//;

async function confirmSnsSubscription(body: Record<string, unknown>): Promise<NextResponse> {
  const subscribeUrl = body.SubscribeURL as string;
  if (subscribeUrl && typeof subscribeUrl === 'string' && SNS_URL_PATTERN.test(subscribeUrl)) {
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
  const ip = extractClientIp(request);
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

  // Filter out stale alerts and alerts with unparseable timestamps
  const now = Date.now();
  const freshAlerts = alerts.filter(a => {
    const alertTime = new Date(a.timestamp).getTime();
    if (isNaN(alertTime)) return false; // reject unparseable timestamps
    return (now - alertTime) < maxAge;
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

// GET: Health check + status + history
export async function GET(_request: Request): Promise<NextResponse> {
  const enabled = isAlertDiagnosisEnabled();
  const config = getAlertDiagnosisConfig();
  const enabledSources = Object.entries(config.sources || {})
    .filter(([, v]) => v?.enabled)
    .map(([k]) => k);

  // Load recent diagnoses and stats for the history section
  let recentDiagnoses: unknown[] = [];
  let stats = null;
  try {
    const { getAlertStats } = await import('@/lib/alert-knowledge');
    stats = await getAlertStats(30);

    // Load recent records (last 30 days, max 20)
    const { existsSync, readdirSync, readFileSync } = await import('fs');
    const { resolve, join } = await import('path');
    const baseDir = resolve(process.cwd(), 'data/alert-diagnosis');
    if (existsSync(baseDir)) {
      const monthDirs = readdirSync(baseDir).filter((d: string) => /^\d{4}-\d{2}$/.test(d)).sort().reverse();
      const records: unknown[] = [];
      for (const md of monthDirs.slice(0, 2)) {
        const files = readdirSync(join(baseDir, md)).filter((f: string) => f.endsWith('.json')).sort().reverse();
        for (const f of files.slice(0, 20 - records.length)) {
          try {
            const raw = readFileSync(join(baseDir, md, f), 'utf-8');
            const rec = JSON.parse(raw);
            // Exclude the full markdown to keep response size small
            const { diagnosisMarkdown: _dm, ...rest } = rec;
            records.push(rest);
          } catch { /* skip */ }
        }
        if (records.length >= 20) break;
      }
      recentDiagnoses = records;
    }
  } catch { /* knowledge base optional */ }

  // Active incidents snapshot (in-memory, since alerts ingested this process)
  const activeIncidents = getActiveIncidents()
    .filter(i => i.status === 'buffering' || i.status === 'investigating')
    .map(i => ({
      id: i.id,
      severity: i.severity,
      status: i.status,
      createdAt: i.createdAt,
      alertCount: i.alerts.length,
      affectedServices: i.affectedServices,
      topAlertName: i.alerts[0]?.alertName || '',
    }));
  const activeCounts = {
    total: activeIncidents.length,
    critical: activeIncidents.filter(i => i.severity === 'critical').length,
    warning: activeIncidents.filter(i => i.severity === 'warning').length,
  };

  return NextResponse.json({
    enabled,
    sources: enabledSources,
    correlationWindowSeconds: config.correlationWindowSeconds || 30,
    deduplicationWindowMinutes: config.deduplicationWindowMinutes || 15,
    minimumSeverity: config.minimumSeverity || 'warning',
    activeIncidents,
    activeCounts,
    recentDiagnoses,
    stats,
  });
}
