// web/lib/connector-invoke.ts
// Invoke a connector MCP Lambda's tool from the BFF (e.g. the schema-refresh route calls <slug>_schema).
// The connector Lambda owns SSRF/VPC/auth; the BFF only orchestrates + persists. Slug allowlisted.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { KNOWN_CONNECTOR_SLUGS } from './integration-credentials';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const PROJECT = process.env.PROJECT || 'awsops-v2';

let lc: LambdaClient | null = null;
function client(): LambdaClient {
  if (!lc) lc = new LambdaClient({ region: REGION });
  return lc;
}

/** Invoke `${PROJECT}-agent-${slug}-mcp` with {tool_name, arguments}; return the parsed connector body. */
export async function invokeConnectorTool(slug: string, toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!(KNOWN_CONNECTOR_SLUGS as readonly string[]).includes(slug)) {
    throw new Error(`unknown connector slug: ${slug}`);
  }
  const resp = await client().send(new InvokeCommand({
    FunctionName: `${PROJECT}-agent-${slug}-mcp`,
    Payload: Buffer.from(JSON.stringify({ tool_name: toolName, arguments: args })),
  }));
  if (resp.FunctionError) throw new Error(`connector ${slug} invoke failed: ${resp.FunctionError}`);
  const raw = resp.Payload ? Buffer.from(resp.Payload).toString('utf8') : '';
  let env: { statusCode?: number; body?: string };
  try { env = JSON.parse(raw); } catch { throw new Error(`connector ${slug} returned non-JSON`); }
  const body = typeof env?.body === 'string' ? JSON.parse(env.body) : env;
  if (env?.statusCode && env.statusCode >= 400) {
    throw new Error((body && (body as { error?: string }).error) || `connector ${slug} error`);
  }
  return body;
}
