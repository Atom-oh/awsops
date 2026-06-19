import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { ResolvedIntegration } from '@/lib/agent-resolver';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ARN_PARAM = process.env.SSM_RUNTIME_ARN_PARAM || '/ops/awsops-v2/agentcore/runtime_arn';
const TTL_MS = 5 * 60 * 1000;

let ssm: SSMClient | null = null;
let ac: BedrockAgentCoreClient | null = null;
let arnCache: { value: string; at: number } | null = null;

export async function getRuntimeArn(): Promise<string> {
  if (arnCache && Date.now() - arnCache.at < TTL_MS) return arnCache.value;
  if (!ssm) ssm = new SSMClient({ region: REGION });
  const r = await ssm.send(new GetParameterCommand({ Name: ARN_PARAM }));
  const value = r.Parameter?.Value;
  if (!value) throw new Error('runtime ARN not found in SSM');
  arnCache = { value, at: Date.now() };
  return value;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export interface InvokeInput {
  gateway: string;
  messages: ChatMsg[];
  sessionId: string; // >=33 chars (a UUID works)
  systemPromptOverride?: string; // ADR-031: resolved custom prompt
  toolAllowlist?: string[];      // ADR-031 Phase 2: now the server-side-enforced set
  agentName?: string;            // ADR-031: traceability
  agentVersion?: number;
  skillHashes?: string[];
  accountId?: string;            // ADR-031 Phase 2: agent.py reads payload.accountId
  accountAlias?: string;
  integrations?: ResolvedIntegration[]; // ADR-039 P2-infra inc2: live egress-READ MCP connections
  extraContext?: string; // bounded BFF context appended to the agent system prompt (e.g. cached datasource schemas)
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

/** Extract the assistant text from one SSE `data:` payload. The streaming agent.py yields
 *  `{"delta": str}` dicts (AgentCore JSON-encodes them); we also tolerate a raw Strands event
 *  (`{"data": str}`), a bare JSON string, or raw text — and treat non-text events (tool use,
 *  lifecycle) as empty. */
function extractDelta(data: string): string {
  try {
    const o = JSON.parse(data);
    if (o && typeof o === 'object') {
      if (typeof (o as { delta?: unknown }).delta === 'string') return (o as { delta: string }).delta;
      if (typeof (o as { data?: unknown }).data === 'string') return (o as { data: string }).data;
      return '';
    }
    return typeof o === 'string' ? o : '';
  } catch {
    return data;
  }
}

/** Map one SSE line to a delta string (or '' to skip non-data / control lines). */
function lineToDelta(line: string): string {
  if (!line.startsWith('data:')) return ''; // skip `event:`/`id:`/comment(`:`)/blank lines
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  return extractDelta(payload);
}

/** Iterate the runtime response as a stream of assistant text deltas. Falls back to a single
 *  buffered chunk when the body isn't an SSE web stream (legacy JSON entrypoint, or a mock). */
async function* streamDeltas(resp: unknown): AsyncGenerator<string> {
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
    if (full) yield full;
    return;
  }
  const reader = webStream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const d = lineToDelta(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (d) yield d;
      }
    }
    buf += dec.decode(); // flush any multibyte remainder held by the decoder
    const tail = lineToDelta(buf); // flush a trailing line that had no newline
    if (tail) yield tail;
  } finally {
    // If the consumer stops early (client abort → the for-await calls .return() here), cancel the
    // upstream body so AgentCore stops generating into the void (no wasted Bedrock tokens). A no-op
    // once the reader has already drained.
    await reader.cancel().catch(() => {});
  }
}

function buildCommand(input: InvokeInput, arn: string): InvokeAgentRuntimeCommand {
  const body: Record<string, unknown> = { gateway: input.gateway, messages: input.messages };
  if (input.systemPromptOverride) body.systemPromptOverride = input.systemPromptOverride;
  if (input.toolAllowlist) body.toolAllowlist = input.toolAllowlist;
  if (input.agentName) body.agentName = input.agentName;
  if (input.agentVersion !== undefined) body.agentVersion = input.agentVersion;
  if (input.skillHashes) body.skillHashes = input.skillHashes;
  if (input.accountId) body.accountId = input.accountId;
  if (input.accountAlias) body.accountAlias = input.accountAlias;
  if (input.integrations?.length) body.integrations = input.integrations;
  if (input.extraContext) body.extraContext = input.extraContext;
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
  const arn = await getRuntimeArn();
  if (!ac) ac = new BedrockAgentCoreClient({ region: REGION });
  const cmd = buildCommand(input, arn);
  try {
    return await ac.send(cmd);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return await ac.send(cmd);
  }
}

/** Invoke the AgentCore runtime, buffering the full answer. Used by fan-out synthesis and k8sgpt
 *  (which need the complete text). Consumes an SSE stream into a string when present; otherwise
 *  reads the legacy buffered JSON. */
export async function invokeAgent(input: InvokeInput): Promise<string> {
  const resp = await send(input);
  if (!isEventStream(resp)) return readResponse(resp);
  let full = '';
  for await (const d of streamDeltas(resp)) full += d;
  return full;
}

/** Invoke the AgentCore runtime and yield assistant text deltas as they arrive (real token
 *  streaming). Used by the single-route chat path. Transparently degrades to a one-shot yield
 *  against a legacy buffered agent image. */
export async function* invokeAgentStream(input: InvokeInput): AsyncGenerator<string> {
  const resp = await send(input);
  yield* streamDeltas(resp);
}
