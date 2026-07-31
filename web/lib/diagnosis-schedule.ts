// Scheduled auto-diagnosis — read/upsert the per-user row in the existing `report_schedules` table
// (singleton per (user_sub, schedule_type); tier/model live in the `config` JSONB; `next_run_at` is NOT NULL
// so it is always set — the `enabled` flag, not a null next-run, gates firing). v1 parity for
// src/lib/report-scheduler.ts. The worker-side dispatcher (EventBridge) scans this table; this module is the
// BFF read/write seam only. Stored times are UTC (TIMESTAMPTZ); KST is a display concern in the UI.
import { getPool } from '@/lib/db';

export type ScheduleFreq = 'weekly' | 'biweekly' | 'monthly';
export const SCHEDULE_FREQS: ScheduleFreq[] = ['weekly', 'biweekly', 'monthly'];

export interface DiagnosisSchedule {
  scheduleType: ScheduleFreq;
  enabled: boolean;
  tier: string;
  model: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** Next run = `from` + one interval, returned as a UTC ISO string. weekly=+7d, biweekly=+14d, monthly=+1 month. */
export function computeNextRun(type: ScheduleFreq, fromISO: string): string {
  const d = new Date(fromISO);
  if (type === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (type === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

interface Row {
  schedule_type: string;
  enabled: boolean;
  next_run_at: string | Date | null;
  last_run_at: string | Date | null;
  config: { tier?: string; model?: string | null } | null;
}

const iso = (v: string | Date | null): string | null => (v == null ? null : new Date(v).toISOString());

function mapRow(r: Row): DiagnosisSchedule {
  const cfg = r.config ?? {};
  return {
    scheduleType: r.schedule_type as ScheduleFreq,
    enabled: r.enabled,
    tier: cfg.tier ?? 'mid',
    model: cfg.model ?? null,
    nextRunAt: iso(r.next_run_at),
    lastRunAt: iso(r.last_run_at),
  };
}

const SELECT_SQL = `SELECT schedule_type, enabled, next_run_at, last_run_at, config
     FROM report_schedules WHERE user_sub = $1 ORDER BY enabled DESC, updated_at DESC LIMIT 1`;

// PR #195 round-3 review MAJOR: round-2 switched ownership keying from the raw Cognito `sub` to
// identity() (email-preferring), but rows created before that switch are still keyed by the old raw
// sub — there's no bulk-rekey table to backfill from (Cognito sub->email isn't stored anywhere
// queryable; this app is stateless-JWT). Self-heal on access instead: whenever a caller's legacy
// sub differs from their current identity(), fold any legacy-keyed row into the identity-keyed slot
// (per schedule_type, only where that slot is free — uq_schedule (user_sub, schedule_type) would
// otherwise conflict), and disable whatever legacy row couldn't move (a stale duplicate) so it can
// never survive un-migrated and double-fire alongside a newly created one.
//
// round-5 review MAJOR: the rename+disable pair must be one transaction — a connection drop between
// them used to leave the legacy row renamed-if-lucky but still enabled otherwise. Wrapped in
// BEGIN/COMMIT so it can't partially apply.
async function migrateLegacyRows(identityKey: string, legacySub: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE report_schedules r SET user_sub = $1
         WHERE r.user_sub = $2
           AND NOT EXISTS (SELECT 1 FROM report_schedules r2 WHERE r2.user_sub = $1 AND r2.schedule_type = r.schedule_type)`,
      [identityKey, legacySub],
    );
    await client.query(`UPDATE report_schedules SET enabled = false WHERE user_sub = $1`, [legacySub]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The caller's current schedule, or null if they have none yet. Scoped by user_sub (no cross-user
 * read). `legacySub` (the caller's raw Cognito sub) triggers the fold-in check on every call, not
 * just the first time — round-5 review MAJOR: a previously-interrupted migration (rename failed,
 * legacy row still enabled) must keep getting retried even after an identity-keyed row exists,
 * or the dispatcher fires both rows forever (duplicate scheduled diagnoses).
 */
export async function readSchedule(userSub: string, legacySub?: string): Promise<DiagnosisSchedule | null> {
  if (legacySub && legacySub !== userSub) await migrateLegacyRows(userSub, legacySub);
  const { rows } = await getPool().query<Row>(SELECT_SQL, [userSub]);
  return rows.length ? mapRow(rows[0]) : null;
}

/** Create/replace the caller's schedule. next_run_at is always recomputed (NOT NULL); `enabled` gates firing. */
export async function upsertSchedule(
  userSub: string,
  input: { scheduleType: ScheduleFreq; enabled: boolean; tier?: string; model?: string | null; nowISO?: string },
  legacySub?: string,
): Promise<DiagnosisSchedule> {
  const nextRunAt = computeNextRun(input.scheduleType, input.nowISO ?? new Date().toISOString());
  const config = { tier: input.tier ?? 'mid', model: input.model ?? null };
  // Fold in any pre-identity()-switch row before disabling/upserting, so a legacy row can never
  // survive un-migrated alongside a freshly created one (see readSchedule/migrateLegacyRows above).
  if (legacySub && legacySub !== userSub) await migrateLegacyRows(userSub, legacySub);
  // One active schedule per user. The table's conflict key is (user_sub, schedule_type), so changing
  // frequency (e.g. weekly→monthly) would INSERT a new row and leave the previous one enabled — the
  // dispatcher (WHERE enabled) would then fire BOTH, and readSchedule (LIMIT 1) would hide the leak.
  // Disable every other-frequency row for this user before upserting the chosen one.
  await getPool().query(
    `UPDATE report_schedules SET enabled = false WHERE user_sub = $1 AND schedule_type <> $2`,
    [userSub, input.scheduleType],
  );
  const { rows } = await getPool().query<Row>(
    `INSERT INTO report_schedules (user_sub, schedule_type, enabled, next_run_at, config)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (user_sub, schedule_type)
     DO UPDATE SET enabled = EXCLUDED.enabled, next_run_at = EXCLUDED.next_run_at, config = EXCLUDED.config
     RETURNING schedule_type, enabled, next_run_at, last_run_at, config`,
    [userSub, input.scheduleType, input.enabled, nextRunAt, JSON.stringify(config)],
  );
  return mapRow(rows[0]);
}
