-- since: 2.0.0
-- worker_jobs.requested_by — server-set requester identity (user.email ?? user.sub), NOT the
-- client-controlled `payload` JSONB. Backs the P0-1 pentest-remediation fix: POST /api/jobs had no
-- verifyUser() call and GET /api/jobs / GET /api/jobs/[id] had no ownership filter, so any request
-- that reached the BFF (or bypassed the edge entirely) could enqueue jobs and read every job's
-- result/artifact_uri. NULL = pre-existing rows and jobs enqueued by internal callers (scheduler
-- dispatcher, reaper) that have no end-user principal — canMutateReport()-style checks treat those
-- as admin-only for reads.
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS requested_by TEXT;
CREATE INDEX IF NOT EXISTS idx_worker_jobs_requested_by ON worker_jobs(requested_by);
