// web/app/api/integrations/ingress/[token]/route.ts
// Phase 2 (W4) — per-integration webhook ingress. Mirrors the AWS DevOps Agent console's "Configure
// Agent Space Webhook": a custom generic_webhook integration gets its own receive_path + a
// self-service-generated credential (see PUT op:'generate-credential' on /api/integrations), instead
// of the shared SSM secret that /api/incidents/webhook uses. Both routes feed the SAME triage/enqueue
// backend (web/lib/incident.ts) — only the auth SOURCE differs (per-integration secret vs shared SSM).
//
// SAFETY (mirrors /api/incidents/webhook — ADR-032 binding rule, autonomous incident lifecycle OFF by
// default): INCIDENT_LIFECYCLE_ENABLED is checked FIRST; when not "true" this route 503s and does NOT
// accept / authenticate / normalize / triage / enqueue anything. A disabled integration row (not yet
// enabled by its admin) also 503s — never auto-accepted before an operator turns it on.
import { NextResponse } from 'next/server';
import { getIntegrationByReceivePath } from '@/lib/integrations';
import { getCredentialById } from '@/lib/integration-credentials';
import { checkRateLimit, extractClientIp, verifyBearer, verifyHmac } from '@/lib/incident-ingress-auth';
import { normalizeAlert, isolatePayload, bearsSelfWritebackMarker } from '@/lib/incident-normalize';
import { triageAndCreateOrLink, enqueueInitialStage } from '@/lib/incident';
import { readTextBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 512 * 1024; // alert payloads are small; large bodies are DoS (mirrors the shared route)

// Own map instance — independent of the shared-secret webhook route's rate limit (see incident-ingress-auth.ts).
const rateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();

export async function POST(request: Request, { params }: { params: { token: string } }): Promise<NextResponse> {
  // BINDING — flag check FIRST: no accept / auth / normalize / triage / enqueue when off.
  if (process.env.INCIDENT_LIFECYCLE_ENABLED !== 'true') {
    return NextResponse.json({ error: 'incident lifecycle disabled (flag off)' }, { status: 503 });
  }

  const ip = extractClientIp(request);
  if (!checkRateLimit(rateLimitMap, ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const integration = await getIntegrationByReceivePath(`/api/integrations/ingress/${params.token}`);
  if (!integration || integration.kind !== 'generic_webhook') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (!integration.enabled) {
    return NextResponse.json({ error: 'integration disabled' }, { status: 503 });
  }

  const cred = await getCredentialById(integration.id);
  if (!cred || typeof cred.secret !== 'string') {
    // Registered but never had "Generate URL and credentials" run — nothing to verify against.
    return NextResponse.json({ error: 'credentials not configured' }, { status: 503 });
  }

  let rawBody: string;
  let body: Record<string, unknown>;
  try {
    rawBody = await readTextBounded(request, MAX_BODY_BYTES);
    body = JSON.parse(rawBody);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const INVALID_AUTH = () => NextResponse.json({ error: 'Invalid authentication' }, { status: 401 });
  if (cred.mode === 'api_key') {
    const bearer = verifyBearer(request.headers.get('authorization'), [cred.secret]);
    if (!bearer.ok) return INVALID_AUTH();
  } else {
    const signature = request.headers.get('x-webhook-signature') || '';
    const result = verifyHmac(rawBody, signature, [cred.secret]);
    if (!signature || !result.ok) return INVALID_AUTH();
  }

  // Same normalization/triage pipeline as /api/incidents/webhook — generic contract only (this route
  // has no SNS/Alertmanager envelope, it's always a direct custom POST).
  const alerts = normalizeAlert(body, 'generic');
  if (alerts.length === 0) {
    return NextResponse.json({ error: 'No valid alerts found in payload' }, { status: 400 });
  }
  const live = alerts.filter((a) => !bearsSelfWritebackMarker(a));
  const droppedSelf = alerts.length - live.length;
  if (live.length === 0) {
    return NextResponse.json({ status: 'dropped_self_writeback', dropped: droppedSelf }, { status: 200 });
  }

  let newCount = 0;
  let linkedCount = 0;
  let skippedCount = 0;
  for (const alert of live) {
    isolatePayload(alert);
    const decision = await triageAndCreateOrLink(alert);
    if (decision.decision === 'New' && decision.incidentId) {
      await enqueueInitialStage(decision.incidentId);
      newCount++;
    } else if (decision.decision === 'Linked') {
      linkedCount++;
    } else {
      skippedCount++;
    }
  }

  return NextResponse.json({
    status: 'accepted', integration: integration.name, alertsReceived: alerts.length,
    new: newCount, linked: linkedCount, skipped: skippedCount, droppedSelfWriteback: droppedSelf,
  }, { status: 202 });
}
