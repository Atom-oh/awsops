// web/app/api/actions/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getPool } from '@/lib/db';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPlan, getAction, setApprovedAndExecuting, recordAudit } from '@/lib/remediation';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let ssm: SSMClient | null = null; let sqs: SQSClient | null = null;
async function killSwitchOn(): Promise<boolean> {
  const name = process.env.MUTATING_ACTIONS_SSM;
  if (!name) return false; // fail-closed
  if (!ssm) ssm = new SSMClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  try { const r = await ssm.send(new GetParameterCommand({ Name: name })); return (r.Parameter?.Value ?? '').toLowerCase() === 'true'; }
  catch { return false; }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ message: 'invalid plan id' }, { status: 400 });
  const plan = await getPlan(params.id);
  return plan ? NextResponse.json(plan) : NextResponse.json({ message: 'plan not found' }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ message: 'invalid plan id' }, { status: 400 });
  let body: any; try { body = await req.json(); } catch { return NextResponse.json({ message: 'invalid JSON' }, { status: 400 }); }
  const op = body?.op;
  const plan = await getPlan(params.id);
  if (!plan) return NextResponse.json({ message: 'plan not found' }, { status: 404 });
  const approver = user.email ?? user.sub;

  if (op === 'cancel') {
    await getPool().query(`UPDATE action_plans SET status='canceled' WHERE plan_id=$1 AND status IN ('planned','approved')`, [params.id]);
    await recordAudit({ planId: params.id, phase: 'approve', principal: approver, decision: 'canceled' });
    return NextResponse.json({ status: 'canceled' });
  }
  if (op !== 'execute') return NextResponse.json({ message: 'op must be execute|cancel' }, { status: 400 });

  // ---- Hard gates: flag (env) + kill-switch (SSM) + 4-eyes (different approver) + not expired ----
  if (process.env.REMEDIATION_ENABLED !== 'true') {
    await recordAudit({ planId: params.id, phase: 'execute', principal: approver, decision: 'flag_off' });
    return NextResponse.json({ message: 'remediation disabled (flag off)' }, { status: 503 });
  }
  if (!(await killSwitchOn())) {
    await recordAudit({ planId: params.id, phase: 'execute', principal: approver, decision: 'killswitch_blocked' });
    return NextResponse.json({ message: 'kill-switch is off' }, { status: 403 });
  }
  if (plan.expired) return NextResponse.json({ message: 'plan expired (>5 min)' }, { status: 410 });
  if (plan.created_by === approver) {
    await recordAudit({ planId: params.id, phase: 'execute', principal: approver, decision: 'denied_self_approval' });
    return NextResponse.json({ message: '4-eyes: approver must differ from creator' }, { status: 403 });
  }
  const action = await getAction(plan.action_name);
  if (!action || !action.enabled) return NextResponse.json({ message: 'action disabled' }, { status: 409 });

  const jobId = randomUUID();
  const ok = await setApprovedAndExecuting(params.id, approver, jobId); // atomic 4-eyes + not-expired guard in SQL
  if (!ok) return NextResponse.json({ message: 'plan not in an approvable state (re-fetch)' }, { status: 409 });

  // Enqueue into the P2 ledger (worker_jobs) + SQS — the dispatcher routes 'action' to the remediation SM.
  await getPool().query(
    `INSERT INTO worker_jobs (job_id, type, payload, dry_run, status, plan_id) VALUES ($1,'action',$2::jsonb,false,'queued',$3)`,
    [jobId, JSON.stringify({ rollback_plan: plan.rollback_plan, ...plan.dry_run, inputs: plan.dry_run?.inputs ?? {} }), params.id]);
  const queueUrl = process.env.JOBS_QUEUE_URL;
  if (queueUrl) {
    if (!sqs) sqs = new SQSClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({
      job_id: jobId, type: 'action', action: plan.action_name, executor_type: action.executorType,
      plan_id: params.id, payload: { rollback_plan: plan.rollback_plan, ...(plan.dry_run?.inputs ?? {}) }, dry_run: false }) }));
  }
  await recordAudit({ planId: params.id, jobId, actionName: plan.action_name, phase: 'execute', principal: approver, decision: 'approved' });
  return NextResponse.json({ status: 'executing', job_id: jobId, approved_by: approver }, { status: 202 });
}
