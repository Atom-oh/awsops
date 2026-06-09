import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';

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
  toolAllowlist?: string[];      // ADR-031: advisory in Phase 1
  agentName?: string;            // ADR-031: traceability
  agentVersion?: number;
  skillHashes?: string[];
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

/** Invoke the AgentCore runtime with the chosen gateway + thread. Returns final text. */
export async function invokeAgent(input: InvokeInput): Promise<string> {
  const arn = await getRuntimeArn();
  if (!ac) ac = new BedrockAgentCoreClient({ region: REGION });
  const body: Record<string, unknown> = { gateway: input.gateway, messages: input.messages };
  if (input.systemPromptOverride) body.systemPromptOverride = input.systemPromptOverride;
  if (input.toolAllowlist) body.toolAllowlist = input.toolAllowlist;
  if (input.agentName) body.agentName = input.agentName;
  if (input.agentVersion !== undefined) body.agentVersion = input.agentVersion;
  if (input.skillHashes) body.skillHashes = input.skillHashes;
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: arn,
    qualifier: 'DEFAULT',
    runtimeSessionId: input.sessionId,
    payload,
  });
  try {
    return await readResponse(await ac.send(cmd));
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return await readResponse(await ac.send(cmd));
  }
}
