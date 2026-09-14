import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { ResolvedIntegration } from '@/lib/agent-resolver';
import { runtimeParameter, validRuntimeArn } from './agentcore-config';
import { normalizeReceipt, normalizeCompletion, ReceiptBuffer, type ToolReceipt, type InvocationCompletion } from './chat-evidence';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ARN_PARAM = runtimeParameter();
const TTL_MS = 5 * 60 * 1000;
const MAX_FRAME = 262144;

let ssm: SSMClient | null = null;
let ac: BedrockAgentCoreClient | null = null;
let arnCache: { value: string; at: number } | null = null;

export async function getRuntimeArn(): Promise<string> {
  if (ARN_PARAM === '') throw new Error('AgentCore disabled');
  if (arnCache && Date.now() - arnCache.at < TTL_MS) return arnCache.value;
  if (!ssm) ssm = new SSMClient({ region: REGION });
  const r = await ssm.send(new GetParameterCommand({ Name: ARN_PARAM }));
  const value = r.Parameter?.Value;
  if (!value || !validRuntimeArn(value, REGION, process.env.HOST_ACCOUNT_ID)) {
    throw new Error('runtime ARN unavailable or invalid');
  }
  arnCache = { value, at: Date.now() };
  return value;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export interface InvokeInput {
  abortSignal?: AbortSignal;
  gateway: string;
  messages: ChatMsg[];
  sessionId: string; // `awsops-<caller's own sub>-<32 lowercase hex chars>`. app/api/chat/route.ts's
  // POST handler always derives this itself — an unscoped/invalid client-supplied value is never
  // passed through untouched, only a value already matching this exact own-namespaced shape
  // (pentest-remediation P3-1, PR #200 review).
  systemPromptOverride?: string; // ADR-031: resolved custom prompt
  toolAllowlist?: string[];      // undefined = legacy unrestricted; [] = explicit deny-all
  agentName?: string;            // ADR-031: traceability
  agentVersion?: number;
  skillHashes?: string[];
  accountId?: string;            // ADR-031 Phase 2: agent.py reads payload.accountId
  accountAlias?: string;
  integrations?: ResolvedIntegration[]; // ADR-039 P2-infra inc2: live egress-READ MCP connections
  extraContext?: string; // bounded BFF context appended to the agent system prompt (e.g. cached datasource schemas)
  responseLanguage?: string; // v1-parity: UI-language directive ('ko'|'en'|'zh'|'ja') — agent.py forces the answer language
}

async function readResponse(resp: unknown): Promise<string> {
  const body = (resp as { response?: { transformToString?: () => Promise<string> } }).response;
  const raw = body?.transformToString ? await body.transformToString() : String(body ?? '');
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

/** True when the runtime answered with a streamed SSE body (the streaming agent.py entrypoint)
 *  rather than a buffered JSON string (the legacy entrypoint). Lets one consumer handle both, so
 *  the agent image and the web image can deploy in any order without a broken window. */
function isEventStream(resp: unknown): boolean {
  const ct = (resp as { contentType?: string }).contentType || '';
  return ct.includes('text/event-stream');
}

/** Accumulated token usage for one answer (agent.py `{"usage": ...}` frame, v1-parity cost footer). */
export interface TokenUsage { inputTokens: number; outputTokens: number }
/** A generated query a tool ran (agent.py `{"toolInput": ...}` frame — SQL/PromQL/... preview). */
export interface ToolQuery { tool: string; query: string }

/** One agent stream event: incremental answer text, a tool invocation, the model id, the
 *  answer's token usage, or a tool's generated query (answer provenance — agent.py emits
 *  `{"tool"}` / `{"model"}` / `{"usage"}` / `{"toolInput"}` frames alongside deltas). */
export interface AgentEvent {
  delta?: string; tool?: string; model?: string; usage?: TokenUsage; toolInput?: ToolQuery;
  receipt?: ToolReceipt; completion?: InvocationCompletion; evidenceTruncated?: boolean; runtimeOutcome?: 'error' | 'unverified';
}

/** Extract an event from one SSE `data:` payload. The streaming agent.py yields
 *  `{"delta": str}` dicts (AgentCore JSON-encodes them) plus `{"tool": str}` / `{"model": str}`
 *  provenance frames; we also tolerate a raw Strands event (`{"data": str}`), a bare JSON
 *  string, or raw text — and treat other non-text events (lifecycle) as null. */
function extractEvent(data: string): AgentEvent | null {
  try {
    const o = JSON.parse(data);
    if (o && typeof o === 'object') {
      const event: AgentEvent = {};
      if ('receipt' in o) {
        const receipt = normalizeReceipt(o.receipt);
        if (receipt) event.receipt = receipt; else event.evidenceTruncated = true;
      }
      if ('completion' in o) {
        const completion = normalizeCompletion(o.completion);
        if (completion) event.completion = completion; else event.evidenceTruncated = true;
      }
      if (o.evidenceTruncated === true) event.evidenceTruncated = true;
      if (o.runtimeOutcome === 'error' || o.runtimeOutcome === 'unverified') event.runtimeOutcome = o.runtimeOutcome;
      if (typeof o.delta === 'string') event.delta = o.delta;
      else if (typeof o.data === 'string') event.delta = o.data;
      if (typeof o.tool === 'string') event.tool = o.tool;
      if (typeof o.model === 'string') event.model = o.model;
      const u = o.usage;
      if (u && typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number') {
        event.usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
      }
      const ti = o.toolInput;
      if (ti && typeof ti.tool === 'string' && typeof ti.query === 'string') event.toolInput = { tool: ti.tool, query: ti.query };
      if (Object.keys(event).length) return event;
      return null;
    }
    return typeof o === 'string' && o ? { delta: o } : null;
  } catch {
    if (/^[{[]/.test(data.trim())) return { evidenceTruncated: true };
    return data ? { delta: data } : null;
  }
}

/** Map one SSE line to an event (or null to skip non-data / control lines). */
function lineToEvent(line: string): AgentEvent | null {
  if (!line.startsWith('data:')) return null; // skip `event:`/`id:`/comment(`:`)/blank lines
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  if (payload.length > MAX_FRAME) return { evidenceTruncated: true };
  return extractEvent(payload);
}

/** Iterate the runtime response as a stream of agent events. Falls back to a single
 *  buffered text chunk when the body isn't an SSE web stream (legacy JSON entrypoint, or a mock). */
async function* streamEvents(resp: unknown, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const body = (resp as {
    response?: {
      transformToWebStream?: () => ReadableStream<Uint8Array>;
      transformToString?: () => Promise<string>;
    };
  }).response;
  const webStream = body?.transformToWebStream?.();
  if (!isEventStream(resp) || !webStream) {
    // Legacy buffered JSON (old agent image) or non-stream mock → yield the whole answer once.
    const full = await readResponse(resp);
    if (full) yield { delta: full };
    return;
  }
  const reader = webStream.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const dec = new TextDecoder();
  let buf = '';
  let discarding = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      let text = dec.decode(value, { stream: true });
      if (discarding) {
        const end = text.indexOf('\n');
        if (end < 0) continue;
        text = text.slice(end + 1);
        discarding = false;
      }
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const ev = lineToEvent(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (ev) yield ev;
      }
      if (buf.length > MAX_FRAME) {
        buf = '';
        discarding = true;
        yield { evidenceTruncated: true };
      }
    }
    buf += dec.decode(); // flush any multibyte remainder held by the decoder
    const tail = discarding ? null : lineToEvent(buf); // flush a trailing line that had no newline
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // If the consumer stops early (client abort → the for-await calls .return() here), cancel the
    // upstream body so AgentCore stops generating into the void (no wasted Bedrock tokens). A no-op
    // once the reader has already drained.
    await reader.cancel().catch(() => {});
  }
}

function buildCommand(input: InvokeInput, arn: string): InvokeAgentRuntimeCommand {
  const body: Record<string, unknown> = { gateway: input.gateway, messages: input.messages };
  if (input.systemPromptOverride) body.systemPromptOverride = input.systemPromptOverride;
  // Old runtimes treat [] as unrestricted. This reserved nonempty token cannot be a
  // Bedrock ToolSpecification name (pattern [a-zA-Z0-9_-]+), so exact-match old filters
  // also deny all. Keep [] in the internal spec; encode only at the transport boundary.
  // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html
  if (input.toolAllowlist !== undefined) {
    body.toolAllowlist = input.toolAllowlist.length ? input.toolAllowlist : ['!awsops-deny-all!'];
  }
  if (input.agentName) body.agentName = input.agentName;
  if (input.agentVersion !== undefined) body.agentVersion = input.agentVersion;
  if (input.skillHashes) body.skillHashes = input.skillHashes;
  if (input.accountId) body.accountId = input.accountId;
  if (input.accountAlias) body.accountAlias = input.accountAlias;
  if (input.integrations?.length) body.integrations = input.integrations;
  if (input.extraContext) body.extraContext = input.extraContext;
  if (input.responseLanguage) body.responseLanguage = input.responseLanguage;
  return new InvokeAgentRuntimeCommand({
    agentRuntimeArn: arn,
    qualifier: 'DEFAULT',
    runtimeSessionId: input.sessionId,
    payload: new TextEncoder().encode(JSON.stringify(body)),
  });
}

/** Send the invoke command, retrying once on a transient send error. The body is NOT consumed
 *  here, so the retry is safe for both the buffered and the streaming consumer. */
async function send(input: InvokeInput): Promise<unknown> {
  input.abortSignal?.throwIfAborted();
  const arn = await getRuntimeArn();
  if (!ac) ac = new BedrockAgentCoreClient({ region: REGION });
  const cmd = buildCommand(input, arn);
  try {
    return await ac.send(cmd, { abortSignal: input.abortSignal });
  } catch {
    input.abortSignal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, 500));
    input.abortSignal?.throwIfAborted();
    return await ac.send(cmd, { abortSignal: input.abortSignal });
  }
}

/** Invoke the AgentCore runtime, buffering the full answer plus provenance (tools invoked,
 *  model id). Tools/model are empty against a legacy agent image that doesn't emit them —
 *  callers must treat both as optional. */
export async function invokeAgentDetailed(input: InvokeInput): Promise<{
  text: string; tools: string[]; model?: string; receipts?: ToolReceipt[]; evidenceTruncated?: boolean; runtimeError?: boolean; completion?: InvocationCompletion; runtimeUnverified?: boolean;
}> {
  const resp = await send(input);
  if (!isEventStream(resp)) return { text: await readResponse(resp), tools: [] };
  let text = '';
  let model: string | undefined;
  const tools: string[] = []; // insertion-ordered; agent.py dedupes per toolUseId, Set guards re-emits
  const seen = new Set<string>();
  const buffer = new ReceiptBuffer();
  let runtimeError = false;
  let runtimeUnverified = false;
  try {
    for await (const ev of streamEvents(resp, input.abortSignal)) {
      if (ev.delta) text += ev.delta;
      if (ev.tool && !seen.has(ev.tool)) { seen.add(ev.tool); tools.push(ev.tool); }
      if (ev.model) model = ev.model;
      if (ev.receipt) buffer.add(ev.receipt);
      if (ev.completion) buffer.finish(ev.completion);
      if (ev.evidenceTruncated) buffer.truncated = true;
      if (ev.runtimeOutcome === 'error') runtimeError = true;
      if (ev.runtimeOutcome === 'unverified') runtimeUnverified = true;
    }
  } catch (e) {
    if (input.abortSignal?.aborted || (!text && !buffer.receipts.length)) throw e;
    runtimeError = true;
  }
  return { text, tools, model, ...(buffer.receipts.length ? { receipts: buffer.receipts } : {}),
    ...(buffer.truncated ? { evidenceTruncated: true } : {}), ...(runtimeError ? { runtimeError: true } : {}),
    ...(buffer.completion ? { completion: buffer.completion } : {}), ...(runtimeUnverified ? { runtimeUnverified: true } : {}) };
}

/** Invoke the AgentCore runtime, buffering the full answer. Used by fan-out synthesis and k8sgpt
 *  (which need the complete text). Consumes an SSE stream into a string when present; otherwise
 *  reads the legacy buffered JSON. */
export async function invokeAgent(input: InvokeInput): Promise<string> {
  const answer = await invokeAgentDetailed(input);
  // Text-only callers cannot carry partial-outcome metadata (e.g. K8sGPT).
  if (answer.runtimeError) throw new Error('Agent runtime interrupted');
  return answer.text;
}

/** Invoke the AgentCore runtime and yield assistant text deltas as they arrive (real token
 *  streaming). Transparently degrades to a one-shot yield against a legacy buffered agent image. */
export async function* invokeAgentStream(input: InvokeInput): AsyncGenerator<string> {
  const resp = await send(input);
  for await (const ev of streamEvents(resp, input.abortSignal)) if (ev.delta) yield ev.delta;
}

/** Invoke the AgentCore runtime and yield each event (delta/tool/model) as it arrives — the
 *  provenance-aware sibling of invokeAgentStream(), for callers that need to forward deltas
 *  live to a client AND still surface tool/model provenance once the stream ends. */
export async function* invokeAgentStreamDetailed(input: InvokeInput): AsyncGenerator<AgentEvent> {
  const resp = await send(input);
  yield* streamEvents(resp, input.abortSignal);
}
