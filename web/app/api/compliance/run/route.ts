import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { enqueueJob, EnqueueDeliveryError } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// Mirror compliance.ALLOWED (worker) — defense-in-depth: reject anything else before enqueue so a
// crafted benchmark string can never reach the Powerpipe argv.
const ALLOWED = new Set(['cis_v150', 'cis_v200', 'cis_v300', 'cis_v400']);

export async function POST(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  if (!process.env.JOBS_QUEUE_URL) {
    return NextResponse.json({ status: 'unconfigured', message: 'workers disabled' }, { status: 503 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: 'invalid JSON body' }, { status: 400 });
  }
  const benchmark = body?.benchmark;
  if (typeof benchmark !== 'string' || !ALLOWED.has(benchmark)) {
    return NextResponse.json({ message: `unknown benchmark; allowed: ${[...ALLOWED].join(', ')}` }, { status: 400 });
  }
  const requestedBy = (user as { email?: string; sub?: string }).email || (user as { sub?: string }).sub || 'unknown';

  // Pre-create the run row (running) — mirrors the _report pattern: fixes the worker_job_id linkage
  // and the UI race (the page can poll the run immediately).
  const ins = await getPool().query(
    `INSERT INTO compliance_runs (benchmark, status, requested_by) VALUES ($1, 'running', $2) RETURNING id`,
    [benchmark, requestedBy],
  );
  const runId = ins.rows[0].id;

  try {
    const { job_id } = await enqueueJob('compliance', { benchmark, run_id: runId, requested_by: requestedBy }, {});
    return NextResponse.json({ run_id: runId, job_id }, { status: 202 });
  } catch (e) {
    if (e instanceof EnqueueDeliveryError) {
      return NextResponse.json({ run_id: runId, job_id: e.job_id, enqueue: 'failed' }, { status: 202 });
    }
    return NextResponse.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
