// POST /api/datasources/test — probe a datasource connection BEFORE saving (v1 "Test connection").
// Admin-gated. Takes an UNSAVED candidate {kind, endpoint, authType, creds}, SSRF-guards the endpoint,
// and invokes the connector's `${kind}_health` tool with an INLINE conn-config (nothing is stored).
// SECURITY: the credential value is never logged or echoed — only {ok, latency_ms, error?} is returned.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { invokeMcpLambdaTool, KNOWN_MCP_LAMBDA_KINDS } from '@/lib/mcp-lambda-invoke';
import { isDatasourceKind } from '@/lib/integrations-category';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { getDatasource } from '@/lib/datasources';
import { getIntegrationCredentialSnapshot } from '@/lib/integration-credentials';
import { effectiveSavedConnection, mergeDatasourceConnection, ConnectionInputError, object } from '@/lib/datasource-connection';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// Upstream error text may echo authorization headers. Classify it, never return it.
function failure(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  if (/401|403|unauthoriz|forbidden|Datadog (?:API key|metric query) validation failed/i.test(text)) {
    return { ok: false, code: 'authentication', error: 'Authentication failed. Check the credentials, API site and read permissions.' };
  }
  if (/ResourceNotFound|AccessDenied|not connected|not configured/i.test(text)) {
    return { ok: false, code: 'configuration', error: 'The connector is unavailable. Ask an administrator to check deployment and access permissions.' };
  }
  if (/timeout|timed out|deadline/i.test(text)) {
    return { ok: false, code: 'timeout', error: 'The connection timed out. Check endpoint reachability and network rules.' };
  }
  return { ok: false, code: 'connection', error: 'Connection test failed. Check the endpoint, credentials and connector availability.' };
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ error: 'admin access required' }, 403);

  let body: Record<string, unknown>;
  try { body = (await readJsonBounded(request)) as typeof body; }
  catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!object(body)) return json({ error: 'body must be an object' }, 400);

  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!isDatasourceKind(kind) || !(KNOWN_MCP_LAMBDA_KINDS as readonly string[]).includes(kind)) {
    return json({ error: 'unknown datasource kind' }, 400);
  }
  if (body.id !== undefined && (typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id <= 0)) {
    return json({ error: 'valid id required' }, 400);
  }
  try {
    const ds = body.id !== undefined ? await getDatasource(body.id as number) : null;
    if (body.id !== undefined && !ds) return json({ error: 'datasource not found' }, 404);
    if (ds && ds.kind !== kind) return json({ error: 'datasource kind does not match' }, 400);
    const saved = ds ? effectiveSavedConnection(ds, await getIntegrationCredentialSnapshot()) : undefined;
    const connConfig = mergeDatasourceConnection(kind, body, saved);

    const started = Date.now();
    const result = (await invokeMcpLambdaTool({
      kind, tool: `${kind}_health`, connConfig,
    })) as { ok?: boolean; latency_ms?: number; error?: string };
    if (result?.ok !== true) return json(failure(result?.error), 200);
    const latencyMs = typeof result.latency_ms === 'number' && Number.isFinite(result.latency_ms) && result.latency_ms >= 0 ? result.latency_ms : Date.now() - started;
    return json({ ok: true, latencyMs }, 200);
  } catch (e) {
    if (e instanceof ConnectionInputError) return json({ error: e.message }, 400);
    return json(failure(e), 200);
  }
}
