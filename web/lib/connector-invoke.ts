// web/lib/connector-invoke.ts
// COMPAT SHIM → web/lib/mcp-lambda-invoke.ts. Existing callers (schema refresh) use the slug-only
// signature; with no inline conn_config the Lambda falls back to its slug/env credential map. New code
// should call invokeMcpLambdaTool directly with a resolved connConfig. (Tidy: remove once no importers.)
import { invokeMcpLambdaTool } from './mcp-lambda-invoke';

export { KNOWN_MCP_LAMBDA_KINDS } from './mcp-lambda-invoke';

/** @deprecated use invokeMcpLambdaTool({ kind, tool, args, connConfig }). */
export async function invokeConnectorTool(
  slug: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return invokeMcpLambdaTool({ kind: slug, tool: toolName, args });
}
