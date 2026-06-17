// web/app/api/incidents/webhook/route.ts
// ADR-032 incident ingress — HMAC webhook (ADR-022 active/standby rotation), PORTED from
// src/app/api/alert-webhook/route.ts (verifySignature + rate-limit + extractClientIp + SNS
// subscription-confirm), ADAPTED to the v2 thin-BFF (root path, node-pg Triage, SSM secrets).
//
// SAFETY (autonomous incident lifecycle shipped OFF):
//   - The env flag is checked FIRST: when INCIDENT_LIFECYCLE_ENABLED !== 'true' this route
//     returns 503 and does NOT accept, HMAC-verify, normalize, triage, or enqueue ANYTHING.
//     There is NO autonomous trigger when off (BINDING). The Triage layer (Task 2) is a second
//     line of defense (it also returns {decision:'disabled'} when off).
//   - Alert payloads are attacker-controlled. We HMAC-verify (ADR-022) before any processing,
//     and only isolated/descriptive data (incident-normalize.isolatePayload) ever flows toward
//     the agent tier — nothing here influences tool perms / sub-agent roster / approval.
//   - This route NEVER executes a mutation. On accept it does Triage (DB write of the incident
//     row) + enqueue of the FIRST stage onto the P2 backbone — the heavy/long investigation runs
//     in the worker/SM tier, not the web tier (thin-BFF rule).
//   - The HMAC secret(s) come from SSM (read once, cached), NOT app-config.
import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { normalizeAlert, detectAlertSource, isolatePayload, bearsSelfWritebackMarker, type AlertSource } from '@/lib/incident-normalize';
import { triageAndCreateOrLink, enqueueInitialStage } from '@/lib/incident';

export const dynamic = 'force-dynamic';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

// --- Rate limiting (PORTED): per-source IP, 60 requests/min, bounded map ---
const rateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_ENTRIES = 10_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
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

// --- Client IP (PORTED): behind CloudFront + ALB, the real client is second-to-last ---
function extractClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const ips = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
  return ips.length >= 2 ? ips[ips.length - 2] : ips[0] || 'unknown';
}

// --- HMAC-SHA256 verify (PORTED): accepts active OR standby secret (ADR-022 rotation) ---
function verifySignature(body: string, signature: string, secrets: Array<string | undefined>): { ok: boolean; matched?: 'active' | 'standby' } {
  const sig = signature.replace(/^sha256=/, '');
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, 'hex');
  } catch {
    return { ok: false };
  }
  const labels: Array<'active' | 'standby'> = ['active', 'standby'];
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i];
    if (!s) continue;
    try {
      const expected = createHmac('sha256', s).update(body).digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
        return { ok: true, matched: labels[i] };
      }
    } catch {
      // try the next secret
    }
  }
  return { ok: false };
}

// --- HMAC secret(s) from SSM (read once, cached) — NOT app-config ---
const TTL_MS = 5 * 60 * 1000;
let ssm: SSMClient | null = null;
const secretCache: Record<string, { value: string | undefined; at: number }> = {};

async function readSsm(name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined;
  const c = secretCache[name];
  if (c && Date.now() - c.at < TTL_MS) return c.value;
  if (!ssm) ssm = new SSMClient({ region: REGION });
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = r.Parameter?.Value || undefined;
    secretCache[name] = { value, at: Date.now() };
    return value;
  } catch {
    return undefined; // degrade-safe: an absent param means that secret is simply not configured
  }
}

async function hmacSecrets(): Promise<Array<string | undefined>> {
  const [active, standby] = await Promise.all([
    readSsm(process.env.SSM_INCIDENT_HMAC_SECRET_PARAM),
    readSsm(process.env.SSM_INCIDENT_HMAC_STANDBY_PARAM),
  ]);
  return [active, standby];
}

// --- SNS subscription confirmation (PORTED): only fetch a genuine AWS SNS URL ---
const SNS_URL_PATTERN = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//;

async function confirmSnsSubscription(body: Record<string, unknown>): Promise<NextResponse> {
  const subscribeUrl = body.SubscribeURL;
  if (typeof subscribeUrl === 'string' && SNS_URL_PATTERN.test(subscribeUrl)) {
    try {
      await fetch(subscribeUrl);
      console.log(`[IncidentWebhook] SNS subscription confirmed: ${body.TopicArn}`);
      return NextResponse.json({ status: 'subscription_confirmed' });
    } catch (err) {
      console.error('[IncidentWebhook] SNS subscription confirmation failed:', err);
    }
  }
  return NextResponse.json({ error: 'Invalid subscription URL' }, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  // BINDING #1 — flag check FIRST: no accept / HMAC / triage / enqueue when off.
  if (process.env.INCIDENT_LIFECYCLE_ENABLED !== 'true') {
    return NextResponse.json({ error: 'incident lifecycle disabled (flag off)' }, { status: 503 });
  }

  // 2 — rate limit (per real client IP)
  const ip = extractClientIp(request);
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  // 3 — parse body
  let rawBody: string;
  let body: Record<string, unknown>;
  try {
    rawBody = await request.text();
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // 4 — SNS subscription confirmation (no HMAC / no triage)
  if (body.Type === 'SubscriptionConfirmation') {
    return confirmSnsSubscription(body);
  }

  // 5 — HMAC verify (ADR-022). Required: an active or standby secret must match.
  const signature = request.headers.get('x-webhook-signature') ||
    request.headers.get('x-hub-signature-256') ||
    request.headers.get('x-alertmanager-signature') || '';
  const result = verifySignature(rawBody, signature, await hmacSecrets());
  if (!signature || !result.ok) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  if (result.matched === 'standby') {
    console.log('[IncidentWebhook] HMAC matched standby secret (ADR-022 rotation; promote+retire)');
  }

  // 6 — detect source + normalize → typed AlertEvent[]
  const sourceHint = request.headers.get('x-alert-source') as AlertSource | null;
  const detectedSource = sourceHint || detectAlertSource(body);
  const alerts = normalizeAlert(body, detectedSource);
  if (alerts.length === 0) {
    return NextResponse.json({ error: 'No valid alerts found in payload' }, { status: 400 });
  }

  // ADR-034 feedback-loop breaker (ALWAYS-ON, independent of rca_writeback_enabled). Drop any event
  // that carries AWSops's own write-back marker so an OpsItem/IM enrichment can never re-trigger RCA.
  // Accepted-and-ignored (200) so the source does not retry. Harmless when nothing writes back.
  const live = alerts.filter((a) => !bearsSelfWritebackMarker(a));
  const droppedSelf = alerts.length - live.length;
  if (live.length === 0) {
    return NextResponse.json({ status: 'dropped_self_writeback', dropped: droppedSelf }, { status: 200 });
  }

  // 7 — Triage each (severity gate + dedup-race live INSIDE triageAndCreateOrLink). isolatePayload
  //     defangs the attacker-controlled text up front (defense in depth; the agent tier re-isolates).
  let newCount = 0;
  let linkedCount = 0;
  let skippedCount = 0;
  for (const alert of live) {
    isolatePayload(alert); // structured isolation — never trust raw alert text downstream
    const decision = await triageAndCreateOrLink(alert);
    if (decision.decision === 'New' && decision.incidentId) {
      // First-stage enqueue rides the P2 backbone (worker_jobs + SQS). No mutation here.
      await enqueueInitialStage(decision.incidentId);
      newCount++;
    } else if (decision.decision === 'Linked') {
      linkedCount++;
    } else {
      skippedCount++; // Skipped or disabled (defense-in-depth: triage also 503-equivalents)
    }
  }

  return NextResponse.json({
    status: 'accepted',
    source: detectedSource,
    alertsReceived: alerts.length,
    new: newCount,
    linked: linkedCount,
    skipped: skippedCount,
    droppedSelfWriteback: droppedSelf,
  }, { status: 202 });
}
