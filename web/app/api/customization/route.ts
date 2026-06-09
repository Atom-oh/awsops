// ADR-031 Phase 1 — admin-gated CRUD for the skill/agent catalog.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { validateSkill, validateAgent } from '@/lib/skill-validation';
import {
  upsertSkill, upsertAgent, attachSkill, setEnabled, listAgentsWithSkills, listSkills, writeAudit,
} from '@/lib/catalog';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function gate(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return { resp: json({ error: 'unauthenticated' }, 401) };
  if (!(await isAdmin(user))) return { resp: json({ error: 'admin access required' }, 403) };
  if (!process.env.AURORA_ENDPOINT) return { resp: json({ error: 'Aurora not configured' }, 400) };
  return { user };
}

export async function GET(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  return json({ aurora: true, agents: await listAgentsWithSkills(), skills: await listSkills() }, 200);
}

export async function POST(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }

  if (body.kind === 'skill') {
    const v = validateSkill(body as never);
    if (!v.ok) return json({ error: 'invalid skill', detail: v.errors }, 400);
    const id = await upsertSkill({
      name: String(body.name), description: String(body.description), instructions: String(body.instructions),
      toolAllowlist: (body.toolAllowlist as string[]) ?? [], tier: 'custom', createdBy: g.user!.email,
    });
    await writeAudit({ actor: g.user!.email ?? g.user!.sub, action: 'upsert', objectType: 'skill', objectId: String(id) });
    return json({ ok: true, id }, 200);
  }
  if (body.kind === 'agent') {
    const v = validateAgent(body as never);
    if (!v.ok) return json({ error: 'invalid agent', detail: v.errors }, 400);
    const id = await upsertAgent({
      name: String(body.name), description: String(body.description), persona: String(body.persona ?? ''),
      routingKeywords: (body.routingKeywords as string[]) ?? [], gateway: String(body.gateway),
      model: body.model ? String(body.model) : undefined, tier: 'custom', createdBy: g.user!.email,
    });
    await writeAudit({ actor: g.user!.email ?? g.user!.sub, action: 'upsert', objectType: 'agent', objectId: String(id) });
    return json({ ok: true, id }, 200);
  }
  return json({ error: 'kind must be skill|agent' }, 400);
}

export async function PUT(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const actor = g.user!.email ?? g.user!.sub;

  if (body.op === 'enable' || body.op === 'disable') {
    if (body.kind !== 'skill' && body.kind !== 'agent') return json({ error: 'kind must be skill|agent' }, 400);
    await setEnabled(body.kind, Number(body.id), body.op === 'enable'); // setEnabled is custom-only at the SQL level
    await writeAudit({ actor, action: String(body.op), objectType: String(body.kind), objectId: String(body.id) });
    return json({ ok: true }, 200);
  }
  if (body.op === 'attach') {
    await attachSkill(Number(body.agentId), Number(body.skillId), Number(body.ord ?? 0));
    await writeAudit({ actor, action: 'attach', objectType: 'agent_skill', objectId: `${body.agentId}:${body.skillId}` });
    return json({ ok: true }, 200);
  }
  return json({ error: 'unknown op' }, 400);
}
