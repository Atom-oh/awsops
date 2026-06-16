import { getPool } from './db';

export type DiagnosisTier = 'light' | 'mid' | 'deep';
// Bedrock model for the report. Only the deep tier may select 'opus'; light/mid are always 'sonnet'.
export type DiagnosisModel = 'sonnet' | 'opus';
export interface DiagnosisReport {
  id: number;
  worker_job_id: string | null;
  tier: DiagnosisTier;
  status: 'running' | 'succeeded' | 'failed' | 'partial';
  requested_by: string;
  sources_used: string[];
  summary: Record<string, unknown>;
  artifact_uri: string | null;
  error: string | null;
  created_at: string;
  // Bedrock model used (NULL on legacy rows → render as 'sonnet'). Display metadata only.
  model: string | null;
  // A3/A5 (V1 parity): live per-section progress written by the worker as generate() advances.
  progress: DiagnosisProgress;
}

export interface DiagnosisProgress {
  current?: number;
  total?: number;
  section?: string;
  phase?: 'collect' | 'render' | 'assemble';
}

const COLS =
  'id, worker_job_id, tier, status, requested_by, sources_used, summary, artifact_uri, error, created_at, model, progress';

export async function listReports(limit = 50): Promise<DiagnosisReport[]> {
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM diagnosis_reports ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows as DiagnosisReport[];
}

export async function getReport(id: number): Promise<DiagnosisReport | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM diagnosis_reports WHERE id = $1`,
    [id],
  );
  return (rows[0] as DiagnosisReport) ?? null;
}

// [GATE-FIX R2 CRITICAL] FK ORDERING: diagnosis_reports.worker_job_id REFERENCES worker_jobs(job_id).
// The row must be created with worker_job_id=NULL (column is nullable), and LINKED only AFTER the
// worker_jobs row exists (post-enqueue) — otherwise the FK insert fails on the first request.
// The worker finds its row via payload.report_id (not the FK), so NULL-at-insert is safe.
// [Plan 2] parent_report_id = the most-recent SUCCEEDED report of the SAME tier (diff lineage). Set
// atomically in the INSERT via a subquery so the worker can compute summary.diff vs the prior run.
export async function createReport(
  tier: DiagnosisTier,
  requestedBy: string,
  model: DiagnosisModel = 'sonnet',
): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO diagnosis_reports (worker_job_id, tier, requested_by, status, parent_report_id, model)
     VALUES (NULL, $1, $2, 'running',
       (SELECT id FROM diagnosis_reports
         WHERE tier = $1 AND status = 'succeeded'
         ORDER BY created_at DESC LIMIT 1),
       $3)
     RETURNING id`,
    [tier, requestedBy, model],
  );
  return rows[0].id as number;
}

// Link the report to its job AFTER enqueueJob has inserted worker_jobs(job_id) (FK now satisfiable).
export async function linkReportJob(reportId: number, workerJobId: string): Promise<void> {
  await getPool().query(
    `UPDATE diagnosis_reports SET worker_job_id = $1 WHERE id = $2`,
    [workerJobId, reportId],
  );
}

// Idempotency-first: return the report already attached to an existing job for this key, if any.
export async function reportForIdempotencyKey(key: string): Promise<number | null> {
  const { rows } = await getPool().query(
    `SELECT r.id FROM diagnosis_reports r JOIN worker_jobs j ON j.job_id = r.worker_job_id
     WHERE j.idempotency_key = $1 ORDER BY r.id DESC LIMIT 1`,
    [key],
  );
  return rows[0]?.id ?? null;
}

// Fail an orphaned 'running' row (e.g. when enqueue throws after createReport).
export async function markReportFailed(reportId: number, msg: string): Promise<void> {
  await getPool().query(
    `UPDATE diagnosis_reports SET status = 'failed', error = $2 WHERE id = $1 AND status = 'running'`,
    [reportId, msg],
  );
}
