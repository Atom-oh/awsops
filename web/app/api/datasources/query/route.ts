// POST /api/datasources/query — execute a read-only query against a datasource INSTANCE.
// Authenticated (read-only exploration), NOT admin. Accepts an instance `id` (preferred — resolves the
// row + credential and passes an inline conn-config so the RIGHT instance is hit) or a `slug`
// (deprecated — the connector Lambda falls back to the kind-mirror = the default instance).
// SECURITY: TOOL holds ONLY read tools; the resolved endpoint is SSRF-guarded before invoke.
import { verifyUser } from '@/lib/auth';
import { invokeMcpLambdaTool, type ConnConfig } from '@/lib/mcp-lambda-invoke';
import { getDatasource } from '@/lib/datasources';
import { getCredentialById } from '@/lib/integration-credentials';
import { isDatasourceKind } from '@/lib/integrations-category';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { normalizeResult } from '@/lib/datasource-render';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

const MAX_QUERY = 8_000;
const CLICKHOUSE_MAX_ROWS = 500;

interface ToolSpec { instant: string; range?: string; arg: 'query' | 'sql'; extra?: Record<string, unknown> }

export const TOOL: Record<string, ToolSpec> = {
  prometheus: { instant: 'prometheus_query', range: 'prometheus_query_range', arg: 'query' },
  mimir: { instant: 'mimir_query', range: 'mimir_query_range', arg: 'query' },
  loki: { instant: 'loki_query', range: 'loki_query_range', arg: 'query' },
  tempo: { instant: 'tempo_search', arg: 'query' },
  clickhouse: { instant: 'clickhouse_query', arg: 'sql', extra: { max_rows: CLICKHOUSE_MAX_ROWS } },
};

export const QUERYABLE_KINDS = Object.keys(TOOL);

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  let body: { id?: unknown; slug?: unknown; query?: unknown; range?: unknown };
  try { body = (await readJsonBounded(request)) as typeof body; }
  catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }

  // Resolve the kind + (for an instance id) the inline conn-config.
  let kind = '';
  let connConfig: ConnConfig | undefined;
  const id = Number(body.id);
  if (Number.isInteger(id) && id > 0) {
    const ds = await getDatasource(id);
    if (!ds || !isDatasourceKind(ds.kind)) return json({ error: 'unknown datasource instance' }, 400);
    kind = ds.kind;
    const cred = await getCredentialById(id, kind);
    if (cred) connConfig = cred as ConnConfig;
  } else {
    kind = typeof body.slug === 'string' ? body.slug : '';
  }

  const spec = TOOL[kind];
  if (!spec) return json({ error: 'datasource is not queryable' }, 400);

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return json({ error: 'query required' }, 400);
  if (query.length > MAX_QUERY) return json({ error: 'query too large' }, 413);

  if (connConfig?.endpoint) {
    try { assertDatasourceEndpointAllowed(connConfig.endpoint); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }

  const tool = body.range === true && spec.range ? spec.range : spec.instant;
  const args: Record<string, unknown> = { [spec.arg]: query, ...(spec.extra ?? {}) };

  try {
    const result = await invokeMcpLambdaTool({ kind, tool, args, connConfig });
    return json({ result: normalizeResult(kind, tool, result) }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'query failed' }, 502);
  }
}
