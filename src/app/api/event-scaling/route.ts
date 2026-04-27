// Event-driven pre-scaling API — Phase 1+2 (ADR-010)
// 이벤트 기반 사전 스케일링 API — Phase 1+2 (ADR-010)
//
// Endpoints (admin-only):
//   GET    ?action=list              → list events (optional ?accountId=)
//   GET    ?action=detail&id=X       → single event with plan
//   GET    ?action=script&id=X       → bash script export (text/x-shellscript)
//   POST   ?action=create            → create event
//   POST   ?action=metrics&id=X      → fetch reference event metrics, attach to event
//   POST   ?action=analyze&id=X      → Bedrock plan generation
//   POST   ?action=approve&id=X      → mark plan as approved
//   PUT    ?action=update&id=X       → update event fields
//   DELETE ?action=cancel&id=X       → mark cancelled (or hard delete via &hard=true)
//
// Phase 3 endpoints (execute, rollback) are intentionally NOT implemented.

import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getUserFromRequest } from '@/lib/auth-utils';
import { getConfig, getAccountById, validateAccountId } from '@/lib/app-config';
import {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  validateCreateInput,
  type ScalingEvent,
  type ScalingPhase,
  type EventStatus,
  type ReferenceEvent,
} from '@/lib/event-scaling';
import {
  SCALING_SYSTEM_PROMPT,
  buildScalingUserPrompt,
  extractPlanFromResponse,
} from '@/lib/event-scaling-prompts';
import {
  fillScriptsIntoPlan,
  generateEventScript,
} from '@/lib/event-scaling-scripts';
import {
  buildMetricsSnapshot,
  fetchCurrentResourceState,
} from '@/lib/queries/event-scaling';

const BEDROCK_REGION = 'ap-northeast-2';
const ANALYSIS_MODEL = 'global.anthropic.claude-sonnet-4-6';

// --- Admin check / 관리자 확인 ---
function isAdminUser(req: NextRequest): boolean {
  const user = getUserFromRequest(req);
  const config = getConfig();
  if (!config.adminEmails || config.adminEmails.length === 0) return true; // fresh install
  return config.adminEmails.includes(user.email);
}

function checkAdmin(req: NextRequest): NextResponse | null {
  if (!isAdminUser(req)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  return null;
}

// --- ID validator / 이벤트 ID 검증 ---
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getRegionForAccount(accountId?: string): { region: string; profile?: string } {
  if (accountId && validateAccountId(accountId)) {
    const acc = getAccountById(accountId);
    if (acc) return { region: acc.region, profile: acc.profile };
  }
  return { region: BEDROCK_REGION };
}

// ============================================================================
// GET — list / detail / script
// ============================================================================
export async function GET(request: NextRequest) {
  const adminError = checkAdmin(request);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';
  const id = searchParams.get('id') || '';
  const accountId = searchParams.get('accountId') || undefined;

  if (action === 'list') {
    const events = listEvents({ accountId });
    return NextResponse.json({ events });
  }

  if (action === 'detail') {
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const event = getEvent(id);
    if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ event });
  }

  if (action === 'script') {
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const event = getEvent(id);
    if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const script = generateEventScript(event);
    const safeName = event.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || event.eventId;
    return new NextResponse(script, {
      status: 200,
      headers: {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}-prescale.sh"`,
      },
    });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}

// ============================================================================
// POST — create / metrics / analyze / approve
// ============================================================================
export async function POST(request: NextRequest) {
  const adminError = checkAdmin(request);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || '';
  const id = searchParams.get('id') || '';
  const user = getUserFromRequest(request);

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // ---- create ----
  if (action === 'create') {
    const err = validateCreateInput(body as Parameters<typeof validateCreateInput>[0]);
    if (err) return NextResponse.json({ error: err }, { status: 400 });

    const event = createEvent({
      name: String(body.name),
      description: body.description ? String(body.description) : undefined,
      eventStart: String(body.eventStart),
      eventEnd: String(body.eventEnd),
      pattern: body.pattern as ScalingEvent['pattern'],
      referenceEvents: (body.referenceEvents as ReferenceEvent[]) || [],
      accountId: body.accountId ? String(body.accountId) : undefined,
      createdBy: user.email,
    });
    return NextResponse.json({ event });
  }

  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const current = getEvent(id);
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // ---- metrics: fetch CloudWatch window for a reference event ----
  if (action === 'metrics') {
    const refIndex = Number(body.referenceIndex ?? 0);
    const ref = current.referenceEvents[refIndex];
    if (!ref) return NextResponse.json({ error: 'referenceIndex out of range' }, { status: 400 });

    const windowMin = ref.windowMinutes || 120;
    const peak = Date.parse(ref.date);
    if (!Number.isFinite(peak)) return NextResponse.json({ error: 'reference date invalid' }, { status: 400 });
    const windowStart = new Date(peak - (windowMin / 2) * 60_000).toISOString();
    const windowEnd = new Date(peak + (windowMin / 2) * 60_000).toISOString();

    const { region, profile } = getRegionForAccount(current.accountId);
    const snapshot = await buildMetricsSnapshot({
      windowStart,
      windowEnd,
      region,
      profile,
      ec2InstanceIds: (body.ec2InstanceIds as string[]) || [],
      rdsInstanceIds: (body.rdsInstanceIds as string[]) || [],
      mskClusterNames: (body.mskClusterNames as string[]) || [],
      elbArns: (body.elbArns as string[]) || [],
      includeSteampipeSnapshot: body.includeSteampipeSnapshot !== false,
      accountId: current.accountId,
    });

    const updatedRefs = [...current.referenceEvents];
    updatedRefs[refIndex] = { ...ref, metricsSnapshot: snapshot };
    const updated = updateEvent(id, { referenceEvents: updatedRefs });
    return NextResponse.json({ event: updated });
  }

  // ---- analyze: invoke Bedrock to generate scaling plan ----
  if (action === 'analyze') {
    const lang: 'ko' | 'en' = body.lang === 'en' ? 'en' : 'ko';
    updateEvent(id, { status: 'analyzing' });

    try {
      const currentResources = await fetchCurrentResourceState(current.accountId);
      const refreshed = getEvent(id);
      if (!refreshed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const userPrompt = buildScalingUserPrompt(refreshed, currentResources, lang);
      const client = new BedrockRuntimeClient({ region: BEDROCK_REGION });
      const response = await client.send(new InvokeModelCommand({
        modelId: ANALYSIS_MODEL,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 6144,
          system: SCALING_SYSTEM_PROMPT(lang),
          messages: [{ role: 'user', content: userPrompt }],
        }),
      }));

      const result = JSON.parse(new TextDecoder().decode(response.body));
      const content = result.content?.[0]?.text || '';
      const inputTokens = result.usage?.input_tokens;
      const outputTokens = result.usage?.output_tokens;

      const parsed = extractPlanFromResponse(content);
      if (!parsed.json) {
        const failed = updateEvent(id, { status: 'planned' });
        return NextResponse.json({
          error: 'Bedrock did not return parseable PLAN_JSON',
          rawContent: content.slice(0, 2000),
          event: failed,
        }, { status: 502 });
      }

      const phasesRaw: ScalingPhase[] = parsed.json.phases.map(p => ({
        phaseNumber: p.phaseNumber,
        label: p.label,
        scheduledOffsetMinutes: p.scheduledOffsetMinutes,
        targets: p.targets.map(t => ({
          resourceType: t.resourceType as ScalingPhase['targets'][number]['resourceType'],
          resourceId: t.resourceId,
          currentValue: Number(t.currentValue),
          targetValue: Number(t.targetValue),
          unit: t.unit,
          rationale: t.rationale,
          script: '',  // filled below
        })),
        notes: p.notes,
      }));
      const phases = fillScriptsIntoPlan(phasesRaw);

      const updated = updateEvent(id, {
        status: 'plan-ready',
        scalingPlan: {
          phases,
          estimatedAdditionalCostUsd: parsed.json.estimatedAdditionalCostUsd,
          modelId: ANALYSIS_MODEL,
          inputTokens,
          outputTokens,
          generatedAt: new Date().toISOString(),
          rawAnalysisMarkdown: parsed.markdown,
        },
      });
      return NextResponse.json({ event: updated });
    } catch (err) {
      updateEvent(id, { status: 'planned' });
      return NextResponse.json({
        error: 'Bedrock invocation failed',
        detail: err instanceof Error ? err.message : String(err),
      }, { status: 500 });
    }
  }

  // ---- approve: mark plan approved ----
  if (action === 'approve') {
    if (!current.scalingPlan) return NextResponse.json({ error: 'No plan to approve' }, { status: 400 });
    const updated = updateEvent(id, {
      status: 'approved',
      scalingPlan: {
        ...current.scalingPlan,
        approvedBy: user.email,
        approvedAt: new Date().toISOString(),
      },
    });
    return NextResponse.json({ event: updated });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}

// ============================================================================
// PUT — update event fields
// ============================================================================
export async function PUT(request: NextRequest) {
  const adminError = checkAdmin(request);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id') || '';
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { body = {}; }

  // Whitelist mutable fields — never let client overwrite eventId/createdAt/scalingPlan via PUT
  const patch: Partial<ScalingEvent> = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.eventStart === 'string' && !isNaN(Date.parse(body.eventStart))) patch.eventStart = body.eventStart;
  if (typeof body.eventEnd === 'string' && !isNaN(Date.parse(body.eventEnd))) patch.eventEnd = body.eventEnd;
  if (body.pattern && typeof body.pattern === 'object') patch.pattern = body.pattern as ScalingEvent['pattern'];
  if (Array.isArray(body.referenceEvents)) patch.referenceEvents = body.referenceEvents as ReferenceEvent[];
  if (typeof body.status === 'string' && ['planned', 'analyzing', 'plan-ready', 'approved', 'cancelled'].includes(body.status)) {
    patch.status = body.status as EventStatus;
  }

  const updated = updateEvent(id, patch);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ event: updated });
}

// ============================================================================
// DELETE — cancel (soft) or hard-delete
// ============================================================================
export async function DELETE(request: NextRequest) {
  const adminError = checkAdmin(request);
  if (adminError) return adminError;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id') || '';
  const hard = searchParams.get('hard') === 'true';
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  if (hard) {
    const ok = deleteEvent(id);
    return NextResponse.json({ ok });
  }

  const updated = updateEvent(id, { status: 'cancelled' });
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ event: updated });
}
