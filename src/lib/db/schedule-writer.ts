// ADR-030 Phase 1 dual-write — report_schedules Aurora UPSERT.
//
// Source of truth during Phase 1 remains data/report-schedule.json. This
// module shadows each writeSchedule() call into the Aurora report_schedules
// table so the 7-day parity gate (ADR-030) can verify equivalence before
// Phase 2 flips reads.
//
// Phase 1 model: the JSON layer has a single global schedule, not per-user.
// We persist with `user_sub = '_global'` as a sentinel so the schema's
// `(user_sub, schedule_type)` UNIQUE constraint works correctly. When
// per-user schedules ship later, callers will pass real user_sub values.

import { getDb, isAuroraEnabled } from '@/lib/db';
import { recordWrite, recordFailure } from '@/lib/db/drift';
import type { ReportSchedule, ScheduleFrequency } from '@/lib/report-scheduler';

const SOURCE = 'report_schedules';
const GLOBAL_SUB = '_global';

// Phase 1 uses a single global row per user_sub. When the user changes the
// frequency (e.g. weekly → monthly), the old (_global, weekly) row would
// otherwise persist alongside the new (_global, monthly) row. Phase 1 parity
// (LIMIT 1 by updated_at) would silently pass, but Phase 2's read cutover
// would inherit broken multi-row state. Issue DELETE-of-stale BEFORE the
// UPSERT, both on the same pool connection.
// AI review on PR #19에서 발견된 이슈 — frequency 변경 시 stale row 누적 방지.
const DELETE_STALE_SQL = `
  DELETE FROM report_schedules
  WHERE user_sub = $1 AND schedule_type <> $2
`;

const UPSERT_SQL = `
  INSERT INTO report_schedules (
    user_sub, schedule_type, enabled, last_run_at, next_run_at, config
  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  ON CONFLICT (user_sub, schedule_type) DO UPDATE SET
    enabled     = EXCLUDED.enabled,
    last_run_at = EXCLUDED.last_run_at,
    next_run_at = EXCLUDED.next_run_at,
    config      = EXCLUDED.config
`;

const SELECT_SQL = `
  SELECT schedule_type, enabled, last_run_at, next_run_at, config, updated_at
  FROM report_schedules
  WHERE user_sub = $1
  ORDER BY updated_at DESC
  LIMIT 1
`;

function buildConfigJson(s: ReportSchedule): string {
  return JSON.stringify({
    day_of_week: s.dayOfWeek,
    day_of_month: s.dayOfMonth,
    hour: s.hour,
    lang: s.lang,
    account_id: s.accountId ?? null,
  });
}

export async function shadowWriteSchedule(schedule: ReportSchedule): Promise<void> {
  if (!isAuroraEnabled()) return;

  const lastRunAt = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
  const nextRunAt = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;

  try {
    const db = await getDb();
    await db.query(DELETE_STALE_SQL, [GLOBAL_SUB, schedule.frequency]);
    await db.query(UPSERT_SQL, [
      GLOBAL_SUB,
      schedule.frequency,
      schedule.enabled,
      lastRunAt,
      nextRunAt,
      buildConfigJson(schedule),
    ]);
    recordWrite(SOURCE);
  } catch (err) {
    recordFailure(SOURCE, err);
    throw err;
  }
}

/**
 * Fire-and-forget wrapper. Returns sync void so the caller (admin API or
 * the scheduler tick) is never blocked on Aurora.
 */
export function fireAndForgetWriteSchedule(schedule: ReportSchedule): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  shadowWriteSchedule(schedule).catch(() => {
    // Drift counter already incremented inside shadowWriteSchedule.
  });
}

export interface AuroraScheduleRow {
  scheduleType: ScheduleFrequency;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  config: Record<string, unknown>;
  updatedAt: string;
}

/**
 * Parity helper — reads the current Aurora row for the global schedule, or
 * null if not present. Date columns are normalized to ISO strings so the
 * parity endpoint can compare against the JSON shape directly.
 */
export async function readScheduleFromAurora(): Promise<AuroraScheduleRow | null> {
  if (!isAuroraEnabled()) return null;
  const db = await getDb();
  const r = await db.query(SELECT_SQL, [GLOBAL_SUB]);
  if (r.rowCount === 0 || r.rows.length === 0) return null;
  const row = r.rows[0] as {
    schedule_type: ScheduleFrequency;
    enabled: boolean;
    last_run_at: Date | null;
    next_run_at: Date | null;
    config: Record<string, unknown>;
    updated_at: Date;
  };
  return {
    scheduleType: row.schedule_type,
    enabled: row.enabled,
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
    nextRunAt: row.next_run_at ? row.next_run_at.toISOString() : null,
    config: row.config ?? {},
    updatedAt: row.updated_at.toISOString(),
  };
}
