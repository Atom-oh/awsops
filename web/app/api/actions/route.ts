// web/app/api/actions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { listCatalog, getAction, createPlan, recordAudit } from '@/lib/remediation';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  return NextResponse.json({ catalog: await listCatalog() });
}

export async function POST(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  let body: any; try { body = await req.json(); } catch { return NextResponse.json({ message: 'invalid JSON' }, { status: 400 }); }
  const action = await getAction(String(body?.action ?? ''));
  if (!action) return NextResponse.json({ message: 'unknown action' }, { status: 400 });
  if (!action.enabled) return NextResponse.json({ message: 'action disabled (catalog enabled=false)' }, { status: 409 });
  const inputs = (body?.inputs && typeof body.inputs === 'object') ? body.inputs : {};
  for (const k of action.requiredInputs) if (!(k in inputs)) return NextResponse.json({ message: `missing input: ${k}` }, { status: 400 });
  // Plan-time dry-run + paired rollback are computed here WITHOUT mutation. In this skeleton the
  // dry-run is a contract echo (the live dry-run runs in the SFN DryRunFirst state at execute time).
  const dryRun = { mode: 'plan', action: action.name, inputs, mutates: false };
  const rollbackPlan = { action: action.name, captured_at: new Date().toISOString(), inputs };
  const plan = await createPlan({ action: action.name, inputs, createdBy: user.email ?? user.sub, dryRun, rollbackPlan });
  await recordAudit({ planId: plan.planId, actionName: action.name, phase: 'plan', principal: user.email ?? user.sub, detail: { inputs } });
  return NextResponse.json({ ...plan, dryRun, rollbackPlan, status: 'planned' }, { status: 201 });
}
