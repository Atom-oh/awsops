import { NextResponse } from 'next/server';
import { verifyUser, identity, matchesIdentity } from '@/lib/auth';
import {
  listReports,
  createReport,
  linkReportJob,
  reportForIdempotencyKey,
  markReportFailed,
  softDeleteReport,
  type DiagnosisModel,
} from '@/lib/diagnosis';
import { isAdmin } from '@/lib/admin';
import { enqueueJob, IdempotencyKeyCollisionError } from '@/lib/jobs';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  // can_edit per report: compute isAdmin ONCE (async + SSM-backed), then compare requested_by.
  const admin = await isAdmin(user);
  const me = identity(user); // pentest-remediation P2-1: match canMutateReport's `||`
  // PR #195 round-4 review MAJOR #1: also scope by the raw sub, so a legacy row (requested_by =
  // sub, written before the identity() switch) still shows up for its real owner.
  const reports = await listReports(50, admin ? null : [me, user.sub]);
  return NextResponse.json({
    reports: reports.map((r) => ({ ...r, can_edit: admin || matchesIdentity(r.requested_by, user) })),
  });
}

export async function POST(req: Request) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });

  let body: any = {};
  try {
    body = await readJsonBounded(req); // bound BEFORE parse (OOM guard)
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ message: 'request body too large' }, { status: 413 });
    /* empty/invalid body OK — defaults apply */
  }
  const tier = ['light', 'mid', 'deep'].includes(body?.tier) ? body.tier : 'mid';
  // Only the deep tier may select Opus; every other tier is pinned to Sonnet (cost guard).
  const model: DiagnosisModel = tier === 'deep' && body?.model === 'opus' ? 'opus' : 'sonnet';
  const hostAccount = process.env.AWS_ACCOUNT_ID || '';
  // [PR#37 review MAJOR] fail fast — an empty account would silently reach the LLM context.
  if (!hostAccount) {
    return NextResponse.json(
      { message: 'AWS_ACCOUNT_ID not configured on the web task' },
      { status: 503 },
    );
  }
  // v1 parity: diagnose a selected member account. Validated against the registered accounts
  // table (12-digit + enabled member) — anything else falls back to the host. The worker's
  // Aurora collectors filter by `scope`; host-credentialed live collectors degrade honestly.
  let account = hostAccount;
  let scope = 'self';
  const requested = typeof body?.account === 'string' ? body.account.trim() : '';
  if (requested && requested !== hostAccount && /^[0-9]{12}$/.test(requested)) {
    try {
      const { rows } = await (await import('@/lib/db')).getPool().query(
        `SELECT 1 FROM accounts WHERE account_id = $1 AND enabled AND NOT is_host`,
        [requested],
      );
      if (rows.length > 0) { account = requested; scope = requested; }
    } catch { /* fall back to host */ }
  }
  const owner = user.sub;   // immutable ownership key — see the note in app/api/jobs/route.ts

  // [GATE-FIX R2 CRITICAL] Idempotency-FIRST → create the report with NULL fk → enqueue (inserts
  // worker_jobs) → LINK. The FK is only set once worker_jobs(job_id) exists.
  const hour = new Date().toISOString().slice(0, 13);
  // The idempotency key deliberately stays on identity(), NOT on the ownership key. They are separate
  // concerns — this one only has to be stable per requester within the hour — and switching it to the
  // sub bought nothing while creating a rolling-deploy discontinuity: a new pod writing
  // `report:<sub>:…` is invisible to an old pod that only knows `report:<email>:…`, so the same user
  // gets a SECOND Bedrock run. A fallback lookup only covered one direction, which is why the
  // key itself is left alone (PR #195 review MAJOR). requested_by below is the immutable sub.
  const key = `report:${identity(user)}:${tier}:${model}:${scope}:${hour}`;

  const existing = await reportForIdempotencyKey(key);
  if (existing) {
    return NextResponse.json({ report_id: existing, tier, model, deduped: true }, { status: 202 });
  }

  const reportId = await createReport(tier, owner, model); // worker_job_id = NULL (FK-safe)
  let job: { job_id: string; status: string; payload?: Record<string, unknown> };
  try {
    job = await enqueueJob(
      'report',
      { account, scope, tier, model, requested_by: owner, report_id: reportId },
      { idempotencyKey: key, requestedBy: owner },
    );
  } catch (e) {
    await markReportFailed(reportId, 'enqueue failed'); // no orphan running row
    // round-6 review MAJOR: clean 409 for a cross-requester idempotency_key collision (this
    // route's key is email-namespaced so it shouldn't fire in practice, but stay consistent with
    // the other enqueueJob callers rather than letting any raw error propagate unhandled).
    if (e instanceof IdempotencyKeyCollisionError) {
      return NextResponse.json({ status: 'error', message: e.message }, { status: 409 });
    }
    throw e;
  }
  // Concurrent same-key requests both pass the check above (it joins through worker_job_id, which is
  // NULL until the link happens), so the second one gets the FIRST job from the conflict path. The
  // LEDGER payload decides who owns it, because the worker obeys the payload — linking our row to a
  // job whose payload names another report strands ours as `running` for good, with no
  // markReportFailed and no reaper coverage (the reaper only reconciles worker_jobs).
  const ledgerReportId = Number((job.payload as { report_id?: unknown } | undefined)?.report_id);
  if (Number.isFinite(ledgerReportId) && ledgerReportId !== reportId) {
    await softDeleteReport(reportId);   // never ran, never will — not a FAILED diagnosis
    return NextResponse.json(
      { job_id: job.job_id, report_id: ledgerReportId, tier, model, deduped: true }, { status: 202 });
  }
  await linkReportJob(reportId, job.job_id); // FK now satisfiable
  return NextResponse.json({ job_id: job.job_id, report_id: reportId, tier, model }, { status: 202 });
}
