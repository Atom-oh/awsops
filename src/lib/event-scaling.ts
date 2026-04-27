// Event-driven pre-scaling — data model + JSON storage (ADR-010 Phase 1+2)
// 이벤트 기반 사전 스케일링 — 데이터 모델 + JSON 저장 (ADR-010 Phase 1+2)
//
// Scope: registration, historical metric snapshots, AI-generated scaling plans,
// and script export. Plan execution is out of scope (Phase 3, separate ADR).

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { randomUUID } from 'crypto';

const BASE_DIR = resolve(process.cwd(), 'data/event-scaling');

export type EventStatus =
  | 'planned'      // registered, no plan yet
  | 'analyzing'    // metrics fetch / AI analysis in flight
  | 'plan-ready'   // scaling plan generated, awaiting approval
  | 'approved'     // plan approved (Phase 2 ends here)
  | 'cancelled';

export type EventPatternType = 'flash-sale' | 'sustained-peak' | 'gradual-ramp' | 'ticket-drop';

export type ScalingResourceType =
  | 'keda'
  | 'hpa'
  | 'aurora-replica'
  | 'aurora-acu'
  | 'msk-broker'
  | 'msk-partition'
  | 'asg'
  | 'ec2'
  | 'ebs-iops'
  | 'alb-capacity';

export interface EventPattern {
  type: EventPatternType;
  expectedPeakMultiplier: number;   // e.g. 10 = 10x normal traffic
  durationMinutes: number;          // expected peak window
  rampUpMinutes: number;            // warm-up window
  customMetrics?: string[];
}

export interface MetricsSnapshot {
  collectedAt: string;
  windowStart: string;
  windowEnd: string;
  cloudwatch?: Record<string, MetricSeries>;  // metricKey → series
  steampipe?: Record<string, unknown>;        // resource snapshot at that time
  notes?: string;
}

export interface MetricSeries {
  label: string;
  unit: string;
  datapoints: Array<{ t: string; v: number }>;
  peak?: number;
  avg?: number;
}

export interface ReferenceEvent {
  name: string;             // e.g. "Black Friday 2025"
  date: string;             // ISO 8601 (peak time)
  windowMinutes?: number;   // window around peak (default 120 = ±60min)
  metricsSnapshot?: MetricsSnapshot;
}

export interface ScalingTarget {
  resourceType: ScalingResourceType;
  resourceId: string;       // ARN, name, or identifier
  currentValue: number;
  targetValue: number;
  unit?: string;            // 'replicas', 'IOPS', 'brokers', 'instances', ...
  rationale?: string;       // why this target
  script: string;           // generated bash/kubectl command (Phase 2)
}

export interface ScalingPhase {
  phaseNumber: number;
  label: string;            // "T-4h: storage + DB warm-up"
  scheduledOffsetMinutes: number; // negative = before eventStart
  targets: ScalingTarget[];
  notes?: string;
}

export interface ScalingPlan {
  phases: ScalingPhase[];
  estimatedAdditionalCostUsd?: number;
  modelId?: string;             // Bedrock model used
  inputTokens?: number;
  outputTokens?: number;
  generatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  rawAnalysisMarkdown?: string; // full Bedrock response for audit
}

export interface ScalingEvent {
  eventId: string;
  name: string;
  description?: string;
  eventStart: string;             // ISO 8601
  eventEnd: string;               // ISO 8601
  status: EventStatus;
  pattern: EventPattern;
  referenceEvents: ReferenceEvent[];
  scalingPlan?: ScalingPlan;
  accountId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Storage ---

function ensureDir(): void {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
}

function eventPath(eventId: string): string {
  return join(BASE_DIR, `${eventId}.json`);
}

export function listEvents(filter?: { accountId?: string; status?: EventStatus }): ScalingEvent[] {
  ensureDir();
  let files: string[] = [];
  try {
    files = readdirSync(BASE_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const events: ScalingEvent[] = [];
  for (const f of files) {
    try {
      const ev = JSON.parse(readFileSync(join(BASE_DIR, f), 'utf-8')) as ScalingEvent;
      if (filter?.accountId && ev.accountId && ev.accountId !== filter.accountId) continue;
      if (filter?.status && ev.status !== filter.status) continue;
      events.push(ev);
    } catch {
      // skip corrupt file
    }
  }
  events.sort((a, b) => (b.eventStart || '').localeCompare(a.eventStart || ''));
  return events;
}

export function getEvent(eventId: string): ScalingEvent | null {
  const p = eventPath(eventId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ScalingEvent;
  } catch {
    return null;
  }
}

export interface CreateEventInput {
  name: string;
  description?: string;
  eventStart: string;
  eventEnd: string;
  pattern: EventPattern;
  referenceEvents?: ReferenceEvent[];
  accountId?: string;
  createdBy?: string;
}

export function createEvent(input: CreateEventInput): ScalingEvent {
  ensureDir();
  const now = new Date().toISOString();
  const event: ScalingEvent = {
    eventId: randomUUID(),
    name: input.name,
    description: input.description,
    eventStart: input.eventStart,
    eventEnd: input.eventEnd,
    status: 'planned',
    pattern: input.pattern,
    referenceEvents: input.referenceEvents || [],
    accountId: input.accountId,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(eventPath(event.eventId), JSON.stringify(event, null, 2), 'utf-8');
  return event;
}

export function updateEvent(eventId: string, patch: Partial<ScalingEvent>): ScalingEvent | null {
  const current = getEvent(eventId);
  if (!current) return null;
  const merged: ScalingEvent = {
    ...current,
    ...patch,
    eventId: current.eventId,        // never overwrite identity
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(eventPath(eventId), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

export function deleteEvent(eventId: string): boolean {
  const p = eventPath(eventId);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// --- Validation ---

export function validateCreateInput(input: Partial<CreateEventInput>): string | null {
  if (!input.name || input.name.trim().length === 0) return 'name is required';
  if (!input.eventStart || isNaN(Date.parse(input.eventStart))) return 'eventStart must be ISO 8601';
  if (!input.eventEnd || isNaN(Date.parse(input.eventEnd))) return 'eventEnd must be ISO 8601';
  if (Date.parse(input.eventStart) >= Date.parse(input.eventEnd)) return 'eventEnd must be after eventStart';
  if (!input.pattern) return 'pattern is required';
  if (!input.pattern.type) return 'pattern.type is required';
  const m = Number(input.pattern.expectedPeakMultiplier);
  if (!Number.isFinite(m) || m < 1 || m > 1000) return 'expectedPeakMultiplier must be 1-1000';
  return null;
}
