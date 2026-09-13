// POST /api/datasources/test — probe a datasource connection BEFORE saving (v1 "Test connection").
// Admin-gated. Takes an UNSAVED candidate {kind, endpoint, authType, creds}, SSRF-guards the endpoint,
// and invokes the connector's `${kind}_health` tool with an INLINE conn-config (nothing is stored).
// SECURITY: the credential value is never logged or echoed — only {ok, latency_ms, error?} is returned.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { invokeMcpLambdaTool, KNOWN_MCP_LAMBDA_KINDS } from '@/lib/mcp-lambda-invoke';
import { isDatasourceKind } from '@/lib/integrations-category';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { getDatasource, sanitizeDsSettings } from '@/lib/datasources';
import { getCredentialById } from '@/lib/integration-credentials';
import { buildAuthHeaders, normalizeDatadogHeaderSlots, type AuthType } from '@/lib/datasource-auth';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

const AUTH_KEYS: Record<AuthType, readonly string[]> = {
  none: [], basic: ['username', 'password'], bearer: ['token'],
  custom_header: ['headerName', 'headerValue', 'headerName2', 'headerValue2'],
};
const CRED_KEYS = [...new Set(Object.values(AUTH_KEYS).flat()), 'org_id'];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Upstream error text may echo authorization headers. Classify it, never return it.
function failure(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  if (/401|403|unauthoriz|forbidden|Datadog API key validation failed/i.test(text)) {
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
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) return json({ error: 'endpoint required' }, 400);
  try { assertDatasourceEndpointAllowed(endpoint); }
  catch { return json({ error: 'Use a valid HTTP(S) datasource endpoint; loopback and metadata addresses are blocked.' }, 400); }
  const url = new URL(endpoint);
  if (url.username || url.password || url.hash || url.search) {
    return json({ error: 'Use the API base URL without embedded credentials, query parameters or fragments.' }, 400);
  }
  if (body.id !== undefined && (typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id <= 0)) {
    return json({ error: 'valid id required' }, 400);
  }
  if (body.creds !== undefined && !object(body.creds)) return json({ error: 'creds must be an object' }, 400);
  if (body.settings !== undefined && !object(body.settings)) return json({ error: 'settings must be an object' }, 400);

  try {
    const ds = body.id !== undefined ? await getDatasource(body.id as number) : null;
    if (body.id !== undefined && !ds) return json({ error: 'datasource not found' }, 404);
    if (ds && ds.kind !== kind) return json({ error: 'datasource kind does not match' }, 400);
    const authType = body.authType ?? ds?.authType ?? 'none';
    if (typeof authType !== 'string' || !Object.hasOwn(AUTH_KEYS, authType)) {
      return json({ error: 'invalid authentication method' }, 400);
    }
    const settings = sanitizeDsSettings(body.settings ?? ds?.settings);
    if (kind !== 'clickhouse') delete settings.database;
    const inputSettings = body.settings;
    if (object(inputSettings) && Object.keys(inputSettings).some(
      (key) => settings[key as keyof typeof settings] !== inputSettings[key],
    )) return json({ error: 'invalid connection settings' }, 400);

    let stored: Record<string, unknown> = {};
    // No kind-mirror fallback. Stored secrets are reusable only for this instance's
    // unchanged URL, including path: a shared host can serve multiple tenants.
    if (ds) {
      const candidate = await getCredentialById(ds.id);
      const savedEndpoint = ds.endpoint ?? candidate?.endpoint;
      if (endpoint === savedEndpoint && object(candidate) && (!candidate.endpoint || candidate.endpoint === endpoint)) {
        stored = kind === 'datadog' ? normalizeDatadogHeaderSlots(candidate) : candidate;
      }
    }
    const creds: Record<string, string> = {};
    const incoming = object(body.creds) ? body.creds : {};
    for (const key of CRED_KEYS) {
      const value = Object.hasOwn(incoming, key) ? incoming[key] : stored[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
        return json({ error: 'invalid credential value' }, 400);
      }
      if (AUTH_KEYS[authType as AuthType].includes(key) || (key === 'org_id' && ['loki', 'tempo', 'mimir'].includes(kind))) creds[key] = value;
    }
    if ((authType === 'bearer' && !creds.token?.trim())
      || (authType === 'basic' && !creds.username?.trim())
      || (authType === 'custom_header' && (!creds.headerName || !creds.headerValue
        || Boolean(creds.headerName2) !== Boolean(creds.headerValue2)))) {
      return json({ error: 'Enter the required credentials. Stored credentials are only reused for the unchanged endpoint.' }, 400);
    }
    try { buildAuthHeaders(authType as AuthType, creds); }
    catch { return json({ error: 'invalid authentication headers' }, 400); }
    const connConfig = { ...creds, ...settings, endpoint, authType };

    const started = Date.now();
    const result = (await invokeMcpLambdaTool({
      kind, tool: `${kind}_health`, connConfig,
    })) as { ok?: boolean; latency_ms?: number; error?: string };
    if (result?.ok !== true) return json(failure(result?.error), 200);
    return json({ ok: true, latencyMs: Date.now() - started }, 200);
  } catch (e) {
    return json(failure(e), 200);
  }
}
