import { verifyUser } from '@/lib/auth';
import { invokeAgent, type ChatMsg } from '@/lib/agentcore';
import { pickGateway } from '@/lib/route';
import { getEnabledCustomAgents } from '@/lib/catalog-source';
import { pickCustomAgent, resolveAgent } from '@/lib/agent-resolver';
import { recordCustomAgentTrace } from '@/lib/trace';

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

  let body: { prompt?: string; messages?: ChatMsg[]; section?: string; sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ status: 'error', message: 'invalid JSON' }, 400);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) return json({ status: 'error', message: 'prompt required' }, 400);
  if (prompt.length > MAX_PROMPT) return json({ status: 'error', message: 'prompt too large' }, 413);

  const sessionId = (body.sessionId && body.sessionId.length >= 33) ? body.sessionId : `awsops-${user.sub}-000000000000000000000000`;
  const gateway = pickGateway(prompt, body.section);
  // ADR-031: resolve a custom agent if one matches; else built-in passthrough (gateway unchanged).
  const customAgents = await getEnabledCustomAgents();          // [] when Aurora off / no customs
  const routeKey = pickCustomAgent(prompt, customAgents) ?? gateway;
  const spec = resolveAgent(routeKey, customAgents);
  const messages: ChatMsg[] = [...(Array.isArray(body.messages) ? body.messages : []), { role: 'user', content: prompt }];

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(': heartbeat\n\n')); // open immediately (CloudFront/ALB keepalive)
      let text: string;
      try {
        text = await invokeAgent({
          gateway: spec.gateway, messages, sessionId,
          systemPromptOverride: spec.systemPromptOverride,
          toolAllowlist: spec.toolAllowlist,
          agentName: spec.agentName, agentVersion: spec.agentVersion, skillHashes: spec.skillHashes,
        });
      } catch (e) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : 'invoke failed' })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      // traceability (fire-and-forget) — only custom invocations
      if (spec.tier === 'custom') {
        void recordCustomAgentTrace({ gateway: spec.gateway, userSub: user.sub, agentName: spec.agentName, agentVersion: spec.agentVersion, tier: spec.tier, skillHashes: spec.skillHashes });
      }
      controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify({ gateway: spec.gateway, agentName: spec.agentName, tier: spec.tier, skillHashes: spec.skillHashes })}\n\n`));
      for (const c of chunk(text)) {
        if (request.signal.aborted) break;
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: c })}\n\n`));
        await new Promise((r) => setTimeout(r, TYPE_DELAY_MS));
      }
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
