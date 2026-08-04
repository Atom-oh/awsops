-- since: 2.0.0
-- One ACTIVE schedule per user — enforced by the DATABASE, because a check cannot do it.
--
-- web/lib/diagnosis-schedule.ts upsertSchedule() disables every other frequency for the user before
-- upserting the chosen one, precisely so exactly one row is ever enabled: the dispatcher fires every
-- `enabled` row, and readSchedule()'s LIMIT 1 would hide the extra one from the UI, so two active rows
-- means a silently doubled diagnosis (and doubled Bedrock spend). That invariant lived only in that
-- function, and UNIQUE (user_sub, schedule_type) does not imply it.
--
-- The owner-sub backfill (scripts/v2/backfill-owner-sub.mjs) rewrites report_schedules.user_sub from a
-- legacy email to the Cognito sub, which can move an enabled row onto a sub that already has an enabled
-- row of a DIFFERENT frequency. No constraint fired, so nothing rolled back. Two rounds of review
-- caught successively weaker attempts to fix that in the tool:
--   1. a plan-time check    — anything created between plan and apply walks past it;
--   2. an in-transaction check — better, but still a READ, so it is subject to isolation. Measured on
--      PG 17 with two connections: under READ COMMITTED the check sees a concurrent commit and aborts,
--      but under SERIALIZABLE the apply's snapshot HIDES that commit, the check passes, and both
--      transactions commit — leaving exactly the two active rows it was meant to prevent. Raising the
--      isolation level made it worse, which is the tell that a check is the wrong tool here.
-- A partial unique index fails the second write with 23505 at the one layer that sees both
-- transactions, whatever their isolation. Callers then only have to recognise the error.
--
-- Partial (WHERE enabled) because disabled history rows are kept deliberately: a user who switches
-- weekly -> monthly leaves the weekly row behind with its config, and several disabled rows per user
-- must stay legal.
--
-- The UPDATE first: live data may already violate this (that is what the backfill review found), and a
-- CREATE UNIQUE INDEX against violating rows aborts the migration and blocks the deploy.
--
-- Tiebreak on created_at, NOT updated_at. `report_schedules` carries a BEFORE UPDATE trigger
-- (trg_schedule_touch → touch_updated_at, schema.sql), and schedule_dispatcher's hourly claim does
-- `UPDATE … SET last_run_at, next_run_at`, so updated_at moves every time a schedule FIRES. Tiebreaking on
-- it would have kept the row that fired most recently and disabled the one the user most recently
-- CONFIGURED — silently, and unrecoverably once this migration has run (review MAJOR, verified against the
-- trigger and the claim SQL). created_at is not touched by firing.
--
-- RETURNING + a NOTICE per disabled row, because this is an irreversible pick made without an operator
-- watching: the log is the only way to answer "which schedule did the migration turn off?" afterwards.
--
-- CONCURRENTLY is deliberately NOT used: migrate.mjs runs statements inside an advisory-locked
-- transaction, which CREATE INDEX CONCURRENTLY cannot join. report_schedules holds at most a few rows
-- per user, so the brief write lock is not a concern.

DO $mig$
DECLARE r RECORD;
BEGIN
  FOR r IN
    UPDATE report_schedules s SET enabled = false          -- updated_at: the trigger sets it
     WHERE s.enabled
       AND s.id <> (SELECT t.id FROM report_schedules t
                     WHERE t.user_sub = s.user_sub AND t.enabled
                     ORDER BY t.created_at DESC, t.id DESC
                     LIMIT 1)
    RETURNING s.id, s.user_sub, s.schedule_type
  LOOP
    RAISE NOTICE 'one-active de-dup: disabled report_schedules id=% user_sub=% type=%',
      r.id, r.user_sub, r.schedule_type;
  END LOOP;
END
$mig$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_one_active
    ON report_schedules (user_sub) WHERE enabled;
