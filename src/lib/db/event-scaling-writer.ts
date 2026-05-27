// ADR-030 Phase 1 dual-write — event_scaling_plans Aurora UPSERT + DELETE.
//
// Source of truth during Phase 1 remains data/event-scaling/<eventId>.json.
// This module shadows each createEvent / updateEvent / deleteEvent call
// into Aurora so the 7-day parity gate (ADR-030) has a queryable
// counterpart before Phase 2 flips reads.
//
// Mutation pattern: each ScalingEvent is a row keyed by plan_id (== eventId).
// Both create and update map to a single INSERT … ON CONFLICT DO UPDATE.
// Delete is a straight DELETE WHERE plan_id = $1.
//
// Schema reference (infra-cdk/data/schema.sql):
//   id BIGSERIAL, plan_id TEXT UNIQUE, event_name TEXT NOT NULL,
//   event_start_at TIMESTAMPTZ NOT NULL, event_end_at TIMESTAMPTZ,
//   status TEXT CHECK IN (...), owner_email TEXT,
//   payload JSONB NOT NULL, created_at, updated_at.

import { getDb, isAuroraEnabled } from '@/lib/db';
import { recordWrite, recordFailure } from '@/lib/db/drift';
import type { ScalingEvent, EventStatus } from '@/lib/event-scaling';

const SOURCE = 'event_scaling_plans';

const UPSERT_SQL = `
  INSERT INTO event_scaling_plans (
    plan_id, event_name, event_start_at, event_end_at,
    status, owner_email, payload
  ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  ON CONFLICT (plan_id) DO UPDATE SET
    event_name     = EXCLUDED.event_name,
    event_start_at = EXCLUDED.event_start_at,
    event_end_at   = EXCLUDED.event_end_at,
    status         = EXCLUDED.status,
    owner_email    = EXCLUDED.owner_email,
    payload        = EXCLUDED.payload
`;

const DELETE_SQL = `DELETE FROM event_scaling_plans WHERE plan_id = $1`;

const SELECT_ALL_SQL = `
  SELECT plan_id, event_name, event_start_at, event_end_at, status,
         owner_email, payload, updated_at
  FROM event_scaling_plans
  ORDER BY event_start_at DESC
`;

const COUNT_SQL = `SELECT COUNT(*)::text AS c FROM event_scaling_plans`;

export async function shadowUpsertEvent(event: ScalingEvent): Promise<void> {
  if (!isAuroraEnabled()) return;
  try {
    const db = await getDb();
    await db.query(UPSERT_SQL, [
      event.eventId,
      event.name,
      new Date(event.eventStart),
      event.eventEnd ? new Date(event.eventEnd) : null,
      event.status,
      event.createdBy ?? null,
      JSON.stringify(event),
    ]);
    recordWrite(SOURCE);
  } catch (err) {
    recordFailure(SOURCE, err);
    throw err;
  }
}

export async function shadowDeleteEvent(eventId: string): Promise<void> {
  if (!isAuroraEnabled()) return;
  try {
    const db = await getDb();
    await db.query(DELETE_SQL, [eventId]);
    recordWrite(SOURCE);
  } catch (err) {
    recordFailure(SOURCE, err);
    throw err;
  }
}

export function fireAndForgetUpsertEvent(event: ScalingEvent): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  shadowUpsertEvent(event).catch(() => {
    // Drift counter already incremented inside shadowUpsertEvent.
  });
}

export function fireAndForgetDeleteEvent(eventId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  shadowDeleteEvent(eventId).catch(() => {
    // Drift counter already incremented inside shadowDeleteEvent.
  });
}

export interface AuroraEventRow {
  planId: string;
  eventName: string;
  eventStartAt: string;
  eventEndAt: string | null;
  status: EventStatus;
  ownerEmail: string | null;
  payload: Record<string, unknown>;
  updatedAt: string;
}

export async function readEventsFromAurora(): Promise<AuroraEventRow[]> {
  if (!isAuroraEnabled()) return [];
  const db = await getDb();
  const r = await db.query(SELECT_ALL_SQL);
  return r.rows.map((row: {
    plan_id: string;
    event_name: string;
    event_start_at: Date;
    event_end_at: Date | null;
    status: EventStatus;
    owner_email: string | null;
    payload: Record<string, unknown>;
    updated_at: Date;
  }) => ({
    planId: row.plan_id,
    eventName: row.event_name,
    eventStartAt: row.event_start_at.toISOString(),
    eventEndAt: row.event_end_at ? row.event_end_at.toISOString() : null,
    status: row.status,
    ownerEmail: row.owner_email,
    payload: row.payload ?? {},
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function countAuroraEvents(): Promise<number> {
  if (!isAuroraEnabled()) return 0;
  const db = await getDb();
  const r = await db.query<{ c: string }>(COUNT_SQL);
  return Number(r.rows[0]?.c ?? 0);
}
