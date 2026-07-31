-- since: 2.1.0
-- worker_jobs.idempotency_key was a single GLOBAL UNIQUE constraint. Diagnosis idempotency keys
-- are deterministic and guessable from a victim's email (report:${email}:${tier}:${model}:
-- ${scope}:${hour}), and /api/jobs accepts a client-supplied idempotency_key for type 'noop'. An
-- attacker who pre-inserts a row under a victim's future key made the victim's real INSERT hit
-- the global UNIQUE constraint (0 rows affected), while the requester-scoped conflict-recovery
-- SELECT (added in the prior PR #195 review round) found no row belonging to the victim's own
-- requester — surfacing as "idempotency conflict but no existing row" (a 500 / failed report for
-- the victim). Round-2 pentest-remediation MAJOR: cross-user idempotency-key DoS.
--
-- Fix: scope the uniqueness by requester instead of globally, via two partial unique indexes.
-- requested_by IS NULL rows (internal-only enqueues: scheduler dispatcher, reaper) have no
-- end-user principal to scope by, and must stay deduped globally amongst themselves exactly like
-- before, so they get their own global-among-NULLs partial index.
ALTER TABLE worker_jobs DROP CONSTRAINT IF EXISTS worker_jobs_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_jobs_idem_internal
  ON worker_jobs (idempotency_key) WHERE requested_by IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_jobs_idem_per_requester
  ON worker_jobs (requested_by, idempotency_key) WHERE requested_by IS NOT NULL;
