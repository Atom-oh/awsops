import { verifyUser } from '@/lib/auth';
import { invokeAgent, invokeAgentStreamDetailed, type ChatMsg } from '@/lib/agentcore';
import { getModelLabel } from '@/lib/bedrock';
import { pickGateway, classifyRoute, type RouteResult } from '@/lib/route';
import { classifyPrompt, buildClassifierContext } from '@/lib/classifier';
import { sanitizeHistory } from '@/lib/chat-context';
import { synthesizeStream } from '@/lib/synthesize';
import { assistantAnswer, isProductHelpIntent } from '@/lib/assistant';
import { sectionByKey } from '@/lib/sections';
import { getEnabledCustomAgents } from '@/lib/catalog-source';
import { isCustomAgentEnabled } from '@/lib/catalog';
import { getEnabledIntegrations } from '@/lib/integrations';
import { pickCustomAgent, resolveAgent } from '@/lib/agent-resolver';
import { recordCustomAgentTrace } from '@/lib/trace';
import { recordExchange } from '@/lib/chat-store';
import { currentAccountId, currentAccountAlias } from '@/lib/account';
import { listConfiguredSchemas, renderSchemaForPrompt } from '@/lib/datasource-schema';
import { listDatasources } from '@/lib/datasources';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { getAgentSpace } from '@/lib/agent-space';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 120; // long agent calls

const MAX_PROMPT = 50_000;
const TYPE_DELAY_MS = Number(process.env.CHAT_TYPEWRITER_MS) || 0;
const STATUS_TICK_MS = 1500;


function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function chunk(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

/** Render cached datasource schemas into a bounded context block for the agent (real names, not dumps).
 *  Uses the shared renderer so SQL datasources (ClickHouse) get their COLUMNS — not just table names —
 *  and OpenSearch domains get their indices, exactly like the Explore "AI로 생성" path. Each datasource
 *  gets a GUARANTEED share of the total budget (so a big ClickHouse schema can't crowd out Prometheus),
 *  and dropped datasources are disclosed instead of silently sliced off. */
const SCHEMA_CTX_TOTAL = 7000; // fits inside the agent's 8000-char extraContext budget with headroom
const SCHEMA_CTX_MAX_DATASOURCES = 12;
function renderSchemaContext(schemas: { label: string; kind: string | null; schema: unknown; version?: string | null }[]): string {
  const header = '## Datasource schemas (cached) — use these real names AND the server version when writing queries';
  const lines = [header];
  const shown = schemas.slice(0, SCHEMA_CTX_MAX_DATASOURCES);
  const perEntry = Math.max(500, Math.floor((SCHEMA_CTX_TOTAL - header.length) / Math.max(1, shown.length)));
  for (const s of shown) {
    const ver = s.version ? ` v${s.version}` : ''; // version informs version-specific DSL/syntax
    const labelLine = `- **${s.label}** (${s.kind ?? ''}${ver}):`;
    const body = renderSchemaForPrompt(s.schema, s.kind, perEntry - labelLine.length - 8); // leave room for the label + indentation
    const indented = body ? '\n' + body.split('\n').map((l) => `  ${l}`).join('\n') : ' (empty)';
    lines.push(`${labelLine}${indented}`);
  }
  if (schemas.length > shown.length) lines.push(`… (+${schemas.length - shown.length} more datasource(s) omitted)`);
  // Absolute backstop: per-entry budgeting doesn't account for per-line indentation, so cap the joined
  // block at SCHEMA_CTX_TOTAL (well within the agent's 8000-char extraContext budget).
  return lines.join('\n').slice(0, SCHEMA_CTX_TOTAL);
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);

  let body: { prompt?: string; messages?: ChatMsg[]; section?: string; switchedFrom?: string; sessionId?: string; threadId?: string };
  try {
    // bound BEFORE parse (App-Router has no default body cap → OOM guard); 512KB covers prompt + thread history
    body = (await readJsonBounded(request, 512_000)) as typeof body;
  } catch (e) {
    if (e instanceof BodyTooLargeError) return json({ status: 'error', message: 'request body too large' }, 413);
    return json({ status: 'error', message: 'invalid JSON' }, 400);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) return json({ status: 'error', message: 'prompt required' }, 400);
  if (prompt.length > MAX_PROMPT) return json({ status: 'error', message: 'prompt too large' }, 413);
  // Sanitize ONCE at the boundary (bug fix, PR #138 review MINOR) — a malformed entry (non-array,
  // or non-string `content`) would otherwise throw deep inside the classifier/assistant history
  // renderers, silently degrading routing instead of failing loud or just being dropped.
  const history = sanitizeHistory(body.messages);

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
    // Bug fix: a context-dependent follow-up (e.g. "저걸 클러스터 안에서 어디서 쓰나" after a
    // CloudTrail/model-invocation question) read in isolation misroutes to the wrong/inactive
    // section — the classifier never saw the prior turn. Feed it a bounded excerpt of the
    // client-supplied history; matchedSections(prompt) below is unaffected (raw prompt only).
    route = await classifyRoute(prompt, body.section, {
      llmEnabled: true,
      classify: (p) => classifyPrompt(buildClassifierContext(history, p)),
    });
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
  const pinIsBuiltin = !!(body.section && sectionByKey(body.section));
  // ADR-044 §2: an explicit pin (picker / pin chip) may target a CUSTOM agent, not only a built-in
  // section — and it sits ABOVE keyword-matched custom agents and the classifier in the ladder.
  // A non-built-in `section` is a custom-agent pin attempt (hybrid path only; legacy is unchanged).
  const customPinTarget = (hybridOn && body.section && !pinIsBuiltin) ? body.section : null;
  const customPinEnabled = customPinTarget
    ? (customAgents.some((a) => a.name === customPinTarget) && (await isCustomAgentEnabled(customPinTarget)))
    : false;
  // ADR-044 §2: a pin to an agent disabled/absent in this Agent Space gets an HONEST message,
  // never a silent fallback to keyword/classifier routing.
  const unavailablePin = !!customPinTarget && !customPinEnabled;
  // ADR-031/039 fail-closed revocation: pickCustomAgent matches against the 30s-cached enabled
  // set; re-check the picked custom agent against Aurora (authoritative) before routing to it, so
  // a just-disabled agent is unusable immediately on every instance (not after the cache TTL).
  const customPick = unavailablePin
    ? null
    : customPinEnabled
      ? customPinTarget                                   // explicit custom pin — highest precedence
      : (hybridOn && pinIsBuiltin) ? null : pickCustomAgent(prompt, customAgents);
  const routeKey = customPinEnabled
    ? customPinTarget!
    : (customPick && (await isCustomAgentEnabled(customPick)) ? customPick : gateway);
  // ADR-039 P2: enabled egress-READ integrations contribute tools + bounded context (per-space scoped).
  // ingress + READ_WRITE contribute nothing here (writes go via the mutating gate).
  // P2-infra inc2: also carry connection details so the resolver can hand agent.py a live-connect list.
  // allowPrivate = the per-account ADR-011 opt-in (no space ⇒ false). sigv4 service/region threading
  // (same-account sigv4 integrations) is deferred with the rest of Q3-sigv4=C — api_key/bearer is live.
  const allowPrivate = space?.allowPrivateDatasource ?? false;
  const enabledIntegrations = await getEnabledIntegrations(accountId);
  const egressReadIntegrations = enabledIntegrations
    .filter((i) => i.direction === 'egress' && i.capability === 'read')
    .map((i) => ({
      name: i.name, exposedTools: i.exposedTools, providedContext: i.providedContext,
      endpoint: i.endpoint ?? undefined, transport: i.transport ?? undefined,
      credentialsRef: i.credentialsRef ?? undefined, allowPrivate,
    }));
  // ADR-040/041 — READ_WRITE integrations are surfaced PROPOSE-ONLY (prompt metadata, NOT live tools;
  // writes go through the human-gated /api/actions path). They never enter the resolver's tool union.
  const proposableWrites = enabledIntegrations
    .filter((i) => i.direction === 'egress' && i.capability === 'read_write')
    .map((i) => ({ name: i.name, writeActionRefs: i.writeActionRefs }));
  const spec = resolveAgent(routeKey, customAgents, space, egressReadIntegrations, proposableWrites); // server-side enforcement
  // ADR-044: cross-domain auto-synthesis (flag MULTI_ROUTE_SYNTHESIS_ENABLED, default OFF ⇒ unchanged
  // single-route path). Only built-in multi-domain fans out — a pinned/picked custom agent stays single.
  // `fanGateways` is the ACTIVE subset of route.selected — the FINAL multi-domain decision is
  // `fanGateways.length >= 2` (gate MAJOR: re-derived from the live `active` flags here, so a stale
  // route.multiDomain can never force a fan-out over an inactive route). Each fan-out gateway gets
  // its OWN built-in invoke input (gate CRITICAL: never reuse the primary's spec/toolAllowlist).
  const synthOn = process.env.MULTI_ROUTE_SYNTHESIS_ENABLED === 'true';
  const fanGateways = (route?.selected ?? []).filter((s) => s.active).map((s) => s.key).slice(0, 3);
  const doFanout = synthOn && hybridOn && !customPick && !unavailablePin && spec.tier === 'builtin'
    && fanGateways.length >= 2;
  // ADR-038 honest inactive handling: built-in section not live yet → no agent call (spec §2.3).
  // Skipped on the fan-out path (every fanGateway is already active-filtered).
  const inactiveSection = !doFanout && hybridOn && spec.tier === 'builtin' && sectionByKey(spec.gateway)?.active === false
    ? sectionByKey(spec.gateway)! : null;
  // AWSops Assistant (product/how-to): no AWS-domain agent can answer "how do I use /customization,
  // build a custom agent, add a Prometheus integration". Fires on a product-help intent (above
  // keyword/classifier, below an explicit pin), OR as the graceful fallback for an AUTO-routed
  // inactive section (instead of the 🔒 dead-end). An EXPLICIT pin to an inactive section keeps 🔒.
  const explicitPin = pinIsBuiltin || customPinEnabled || unavailablePin;
  const inactiveWasPinned = inactiveSection != null && route?.method === 'pin';
  const useAssistant = hybridOn && !unavailablePin
    && ((!explicitPin && isProductHelpIntent(prompt)) || (inactiveSection != null && !inactiveWasPinned));
  const messages: ChatMsg[] = [...history, { role: 'user', content: prompt }];
  // Thread persistence: adopt a well-formed client threadId, else mint one. Ownership is
  // enforced at write time by chat-store's owner-guarded upsert (forged ids just drop).
  const THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const threadId = (typeof body.threadId === 'string' && THREAD_RE.test(body.threadId)) ? body.threadId : randomUUID();
  const via = doFanout ? `multi:${fanGateways.join('+')}` : undefined;
  const recordGateway = useAssistant ? 'assistant' : spec.gateway;
  const exchangeMeta = useAssistant
    ? { assistant: true }
    : route
      ? { ranked: route.ranked, method: route.method, ...(via ? { via, routes: fanGateways } : {}), ...(spec.tier === 'custom' ? { customAgent: spec.agentName } : {}) }
      : (spec.tier === 'custom' ? { customAgent: spec.agentName } : undefined);
  // extras = answer provenance (tools/model/elapsedMs) known only after the invoke — merged into
  // the stored meta so a restored thread renders the same footer as the live stream.
  const record = (assistantContent: string, extras?: Record<string, unknown>) => {
    recordExchange({
      threadId, userSub: user.sub, sessionId,
      promptTitle: prompt.slice(0, 40),
      userContent: prompt, assistantContent,
      gateway: recordGateway, meta: extras ? { ...(exchangeMeta ?? {}), ...extras } : exchangeMeta,
    }).catch(() => { /* store is never-throws by contract; belt-and-suspenders (P2 gate) */ });
  };

  // Inject cached datasource schemas (the agent reads the cache) for the observability gateways —
  // for the single-route spec AND any matching gateway in a fan-out. 'observability' owns the
  // Prometheus/ClickHouse connectors (routed to external-obs); monitoring/data kept for any
  // datasource connectors still hosted there (Loki/Tempo/Mimir/OpenSearch — deferred).
  const obs = (g: string) => g === 'observability' || g === 'monitoring' || g === 'data';
  let datasourceSchemaContext: string | undefined;
  if (obs(spec.gateway) || (doFanout && fanGateways.some(obs))) {
    try {
      // Multi-instance: inject ONLY the DEFAULT instance's schema per kind (no duplicate same-kind
      // instances), labeled by the instance name. The agent gateway path also resolves the default
      // (via the kind-mirror credential), so chat and the gateway agree on which instance is used.
      const [schemas, dsRows] = await Promise.all([listConfiguredSchemas(accountId), listDatasources()]);
      const byId = new Map(schemas.map((s) => [s.integrationId, s]));
      const entries = dsRows
        .filter((d) => d.isDefault && byId.has(d.id))
        .map((d) => { const s = byId.get(d.id)!; return { label: d.name, kind: d.kind, schema: s.schema, version: s.version }; });
      if (entries.length) datasourceSchemaContext = renderSchemaContext(entries);
    } catch { /* schema cache is best-effort; the agent still works (can call discovery tools) without it */ }
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(': heartbeat\n\n')); // open immediately (CloudFront/ALB keepalive)
      // meta is ALWAYS emitted, on every path incl. inactive/fallback (spec §6).
      const meta = {
        gateway: useAssistant ? 'assistant' : spec.gateway,
        agentName: useAssistant ? 'AWSops Assistant' : spec.agentName,
        tier: spec.tier, skillHashes: spec.skillHashes, threadId,
        ...(useAssistant ? { assistant: true } : {}),
        // chips/via are suppressed on the assistant path (no section hand-off for a product answer).
        ...(route && !useAssistant ? { ranked: route.ranked, method: route.method } : {}),
        // ADR-044: emit via/routes IMMEDIATELY from the attempt list (gate MINOR — never wait for
        // Promise.allSettled survivors, which would stall the badge/Thinking UX for the whole fan-out).
        ...(via ? { via, routes: fanGateways } : {}),
        ...(!useAssistant && spec.tier === 'custom' ? { customAgent: spec.agentName, spaceVersion: spec.spaceVersion } : {}),
      };
      controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`));
      // ADR-044 §2: an explicit pin to a custom agent disabled/absent in this Agent Space gets an
      // HONEST message — never a silent fallback to keyword/classifier routing.
      if (unavailablePin) {
        const name = String(body.section).slice(0, 40);
        const guide = `🔒 선택한 에이전트 '${name}'는 이 Agent Space에서 사용할 수 없습니다(비활성화되었거나 존재하지 않음). 다른 에이전트를 선택하거나 자동 라우팅으로 다시 시도해 주세요.`;
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: guide })}\n\n`));
        record(guide);
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      // AWSops Assistant: product/how-to answer grounded in the KB (Bedrock-direct), OR the graceful
      // fallback for an auto-routed inactive section — instead of the 🔒 dead-end.
      if (useAssistant) {
        // Bug fix: pass the client-supplied history along so the assistant fallback isn't a
        // context-blind one-off (previously dropped, causing "질문이 맥락 없이..." answers on
        // any follow-up that landed here — e.g. via the inactive-section degrade path above).
        const text = await assistantAnswer(prompt, { history }); // Haiku, KB-grounded, never throws
        for (const c of chunk(text)) {
          if (request.signal.aborted) break;
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: c })}\n\n`));
          if (TYPE_DELAY_MS) await new Promise((r) => setTimeout(r, TYPE_DELAY_MS));
        }
        if (!request.signal.aborted) record(text);
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      // ADR-044 cross-domain auto-synthesis: fan out over the selected built-in gateways, then merge.
      if (doFanout) {
        // gate CRITICAL: each gateway gets its OWN built-in invoke input (no shared primary spec).
        const settled = await Promise.allSettled(
          fanGateways.map((g) => invokeAgent({
            gateway: g, messages, sessionId, accountId, accountAlias,
            extraContext: obs(g) ? datasourceSchemaContext : undefined, // cached schema reaches fanned monitoring/data agents too
          })),
        );
        const survivors = settled.flatMap((r, i) =>
          r.status === 'fulfilled' ? [{ gateway: fanGateways[i], text: r.value }] : []);
        if (survivors.length === 0) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: 'all routes failed' })}\n\n`));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        // synthesizeStream: ≥2 survivors → merged stream; exactly 1 → passthrough (no extra Bedrock call).
        // abortSignal threaded into the Bedrock call so a client disconnect stops token generation (cost).
        let full = '';
        for await (const t of synthesizeStream(prompt, survivors, { abortSignal: request.signal })) {
          if (request.signal.aborted) break;
          full += t;
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: t })}\n\n`));
        }
        if (!request.signal.aborted) record(full); // don't persist a half-streamed, client-aborted answer
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
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
      let text = '';
      let provenance: { tools: string[]; model?: string } = { tools: [] };
      const t0 = Date.now();
      controller.enqueue(enc.encode('event: status\ndata: ' + JSON.stringify({ phase: 'analyzing' }) + '\n\n'));
      const tick = setInterval(() => {
        if (!request.signal.aborted) {
          controller.enqueue(enc.encode('event: status\ndata: ' + JSON.stringify({ phase: 'working', elapsedMs: Date.now() - t0 }) + '\n\n'));
        }
      }, STATUS_TICK_MS);

      const onAbort = () => {
        clearInterval(tick);
      };
      request.signal.addEventListener('abort', onAbort);

      // Real streaming, not buffered-then-rechunked: forward each delta the instant it arrives
      // from the AgentCore runtime (which itself streams token-by-token, agent/agent.py's
      // stream_async) instead of awaiting the full answer first — the previous invokeAgentDetailed
      // + chunk(text) loop only *looked* like streaming (it re-split an already-complete string
      // and enqueued it in one tick, since CHAT_TYPEWRITER_MS defaults to 0).
      const tools: string[] = [];
      const seenTools = new Set<string>();
      let model: string | undefined;
      try {
        for await (const ev of invokeAgentStreamDetailed({
          gateway: spec.gateway, messages, sessionId,
          systemPromptOverride: spec.systemPromptOverride,
          toolAllowlist: spec.toolAllowlist,
          agentName: spec.agentName, agentVersion: spec.agentVersion, skillHashes: spec.skillHashes,
          accountId, accountAlias,
          integrations: spec.integrations, // ADR-039 P2-infra inc2: live egress-READ MCP connections
          extraContext: datasourceSchemaContext, // cached datasource schemas → agent reads the cache
        })) {
          if (request.signal.aborted) break;
          // Independent ifs, not else-if: AgentEvent's fields aren't guaranteed mutually
          // exclusive by the type, so a frame carrying more than one must not drop any of them.
          if (ev.delta) {
            text += ev.delta;
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: ev.delta })}\n\n`));
          }
          if (ev.tool && !seenTools.has(ev.tool)) { seenTools.add(ev.tool); tools.push(ev.tool); }
          if (ev.model) model = ev.model;
        }
        provenance = { tools, model };
      } catch (e) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : 'invoke failed' })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      } finally {
        clearInterval(tick);
        request.signal.removeEventListener('abort', onAbort);
      }
      // traceability (fire-and-forget) — only custom invocations
      if (spec.tier === 'custom') {
        void recordCustomAgentTrace({ gateway: spec.gateway, userSub: user.sub, agentName: spec.agentName, agentVersion: spec.agentVersion, tier: spec.tier, skillHashes: spec.skillHashes, spaceVersion: spec.spaceVersion });
      }
      // Answer-provenance footer (design handoff 개선안 ③): server-measured elapsed is the
      // authoritative total (the periodic `status` ticks stop once the invoke resolves), plus
      // the tools the agent actually called and its model — all unknown before this point.
      const footerMeta = {
        elapsedMs: Date.now() - t0,
        ...(provenance.tools.length ? { tools: provenance.tools } : {}),
        ...(provenance.model ? { model: getModelLabel(provenance.model) } : {}),
      };
      controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify(footerMeta)}\n\n`));
      // don't persist a half-streamed, client-aborted answer (same guard as the assistant/fanout paths)
      if (!request.signal.aborted) record(text, footerMeta);
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
