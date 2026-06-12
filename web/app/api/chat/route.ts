import { verifyUser } from '@/lib/auth';
import { invokeAgent, type ChatMsg } from '@/lib/agentcore';
import { pickGateway, classifyRoute, type RouteResult } from '@/lib/route';
import { classifyPrompt } from '@/lib/classifier';
import { sectionByKey } from '@/lib/sections';
import { getEnabledCustomAgents } from '@/lib/catalog-source';
import { isCustomAgentEnabled } from '@/lib/catalog';
import { pickCustomAgent, resolveAgent } from '@/lib/agent-resolver';
import { recordCustomAgentTrace } from '@/lib/trace';
import { recordExchange } from '@/lib/chat-store';
import { currentAccountId, currentAccountAlias } from '@/lib/account';
import { getAgentSpace } from '@/lib/agent-space';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 120; // long agent calls

const MAX_PROMPT = 50_000;
const TYPE_DELAY_MS = 12;

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function chunk(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);

  let body: { prompt?: string; messages?: ChatMsg[]; section?: string; switchedFrom?: string; sessionId?: string; threadId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ status: 'error', message: 'invalid JSON' }, 400);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) return json({ status: 'error', message: 'prompt required' }, 400);
  if (prompt.length > MAX_PROMPT) return json({ status: 'error', message: 'prompt too large' }, 413);

  const sessionId = (body.sessionId && body.sessionId.length >= 33) ? body.sessionId : `awsops-${user.sub}-000000000000000000000000`;
  // ADR-038: hybrid routing behind HYBRID_ROUTING_ENABLED. Flag off = exact legacy path.
  const hybridOn = process.env.HYBRID_ROUTING_ENABLED === 'true';
  // ADR-038 §5: a chip-switch resend marks the previous answer as a misroute candidate.
  // Structured log → CloudWatch Logs (durable enough for the P4 semantic-routing corpus).
  if (hybridOn && typeof body.switchedFrom === 'string' && body.switchedFrom) {
    console.warn(JSON.stringify({ evt: 'misroute', from: body.switchedFrom, to: body.section ?? null, user: user.sub, promptLen: prompt.length }));
  }
  let route: RouteResult | null = null;
  let gateway: string;
  if (hybridOn) {
    route = await classifyRoute(prompt, body.section, { llmEnabled: true, classify: classifyPrompt });
    gateway = route.primary;
  } else {
    gateway = pickGateway(prompt, body.section);
  }
  // ADR-031 custom agents. ADR-038 precedence: explicit pin > custom > classifier (spec §2.2).
  // ADR-031 Phase 2: per-account Agent Space. No row ⇒ Phase-1 global behavior.
  const accountId = currentAccountId();
  const accountAlias = currentAccountAlias();
  const customAgents = await getEnabledCustomAgents(accountId);   // [] when Aurora off / no customs
  const space = await getAgentSpace(accountId);                   // null ⇒ Phase-1
  const pinIsValid = !!(body.section && sectionByKey(body.section));
  // ADR-031/039 fail-closed revocation: pickCustomAgent matches against the 30s-cached enabled
  // set; re-check the picked custom agent against Aurora (authoritative) before routing to it, so
  // a just-disabled agent is unusable immediately on every instance (not after the cache TTL).
  const customPick = (hybridOn && pinIsValid) ? null : pickCustomAgent(prompt, customAgents);
  const routeKey = customPick && (await isCustomAgentEnabled(customPick)) ? customPick : gateway;
  const spec = resolveAgent(routeKey, customAgents, space);       // server-side enforcement
  // ADR-038 honest inactive handling: built-in section not live yet → no agent call (spec §2.3).
  const inactiveSection = hybridOn && spec.tier === 'builtin' && sectionByKey(spec.gateway)?.active === false
    ? sectionByKey(spec.gateway)! : null;
  const messages: ChatMsg[] = [...(Array.isArray(body.messages) ? body.messages : []), { role: 'user', content: prompt }];
  // Thread persistence: adopt a well-formed client threadId, else mint one. Ownership is
  // enforced at write time by chat-store's owner-guarded upsert (forged ids just drop).
  const THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const threadId = (typeof body.threadId === 'string' && THREAD_RE.test(body.threadId)) ? body.threadId : randomUUID();
  const exchangeMeta = route
    ? { ranked: route.ranked, method: route.method, ...(spec.tier === 'custom' ? { customAgent: spec.agentName } : {}) }
    : (spec.tier === 'custom' ? { customAgent: spec.agentName } : undefined);
  const record = (assistantContent: string) => {
    recordExchange({
      threadId, userSub: user.sub, sessionId,
      promptTitle: prompt.slice(0, 40),
      userContent: prompt, assistantContent,
      gateway: spec.gateway, meta: exchangeMeta,
    }).catch(() => { /* store is never-throws by contract; belt-and-suspenders (P2 gate) */ });
  };

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(': heartbeat\n\n')); // open immediately (CloudFront/ALB keepalive)
      // meta is ALWAYS emitted, on every path incl. inactive/fallback (spec §6).
      const meta = {
        gateway: spec.gateway, agentName: spec.agentName, tier: spec.tier, skillHashes: spec.skillHashes, threadId,
        ...(route ? { ranked: route.ranked, method: route.method } : {}),
        ...(spec.tier === 'custom' ? { customAgent: spec.agentName, spaceVersion: spec.spaceVersion } : {}),
      };
      controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`));
      if (inactiveSection) {
        const alts = (route?.ranked ?? []).filter((r) => r.active).map((r) => r.key).join(', ');
        const guide = `🔒 ${inactiveSection.label} 에이전트는 P3에서 제공 예정입니다.` +
          (alts ? ` 활성 섹션(${alts}) 칩으로 다시 시도해 주세요.` : ' 활성 섹션으로 다시 시도해 주세요.');
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: guide })}\n\n`));
        record(guide); // the question is worth keeping even when the section isn't live (spec §3)
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      let text: string;
      try {
        text = await invokeAgent({
          gateway: spec.gateway, messages, sessionId,
          systemPromptOverride: spec.systemPromptOverride,
          toolAllowlist: spec.toolAllowlist,
          agentName: spec.agentName, agentVersion: spec.agentVersion, skillHashes: spec.skillHashes,
          accountId, accountAlias,
        });
      } catch (e) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : 'invoke failed' })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      // traceability (fire-and-forget) — only custom invocations
      if (spec.tier === 'custom') {
        void recordCustomAgentTrace({ gateway: spec.gateway, userSub: user.sub, agentName: spec.agentName, agentVersion: spec.agentVersion, tier: spec.tier, skillHashes: spec.skillHashes, spaceVersion: spec.spaceVersion });
      }
      for (const c of chunk(text)) {
        if (request.signal.aborted) break;
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: c })}\n\n`));
        await new Promise((r) => setTimeout(r, TYPE_DELAY_MS));
      }
      record(text); // fire-and-forget after the chunk loop, before [DONE] (P2 gate placement)
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
