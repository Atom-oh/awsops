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
-- CREATE UNIQUE INDEX against violating rows aborts the migration and blocks the deploy. Keeping the
-- most recently updated row is not an arbitrary choice — it is what upsertSchedule() would have left
-- enabled, since it disables the others on every write.
--
-- CONCURRENTLY is deliberately NOT used: migrate.mjs runs statements inside an advisory-locked
-- transaction, which CREATE INDEX CONCURRENTLY cannot join. report_schedules holds at most a few rows
-- per user, so the brief write lock is not a concern.

UPDATE report_schedules s SET enabled = false, updated_at = NOW()
 WHERE s.enabled
   AND s.id <> (SELECT t.id FROM report_schedules t
                 WHERE t.user_sub = s.user_sub AND t.enabled
                 ORDER BY t.updated_at DESC NULLS LAST, t.id DESC
                 LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_one_active
    ON report_schedules (user_sub) WHERE enabled;
