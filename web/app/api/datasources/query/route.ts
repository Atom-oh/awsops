// POST /api/datasources/query — execute a read-only query against a datasource INSTANCE.
// Authenticated (read-only exploration), NOT admin. Accepts an instance `id` (preferred — resolves the
// row + credential and passes an inline conn-config so the RIGHT instance is hit) or a `slug`
// (deprecated — the connector Lambda falls back to the kind-mirror = the default instance).
// SECURITY: TOOL holds ONLY read tools; the resolved endpoint is SSRF-guarded before invoke.
import { verifyUser } from '@/lib/auth';
import { invokeMcpLambdaTool, type ConnConfig } from '@/lib/mcp-lambda-invoke';
import { getDatasource, resolveConnConfig } from '@/lib/datasources';
import { isDatasourceKind } from '@/lib/integrations-category';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { normalizeResult } from '@/lib/datasource-render';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { TOOL } from '@/lib/datasource-query-tools';

export const dynamic = 'force-dynamic';

const MAX_QUERY = 8_000;

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
    connConfig = await resolveConnConfig(ds); // row endpoint (authoritative) + SM cred — works even for auth=none
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

  const args: Record<string, unknown> = { [spec.arg]: query, ...(spec.extra ?? {}) };

  // Range mode: absent/false = instant; true = legacy 1h range (connector default);
  // { window, step } = explicit time range — validated here, start/end computed from the request clock.
  let tool = spec.instant;
  const r = body.range;
  if (spec.range && r === true) {
    tool = spec.range; // back-compat: connector applies its 1h / 60s default
  } else if (spec.range && r && typeof r === 'object') {
    const window = Number((r as { window?: unknown }).window);
    const step = Number((r as { step?: unknown }).step);
    if (!Number.isInteger(window) || window < 60 || window > 86400) {
      return json({ error: 'range.window must be an integer in [60, 86400] seconds' }, 400);
    }
    if (!Number.isInteger(step) || step < 1 || step > 86400) {
      return json({ error: 'range.step must be an integer in [1, 86400] seconds' }, 400);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    tool = spec.range;
    args.start = String(nowSec - window);
    args.end = String(nowSec);
    args.step = String(step);
  }

  try {
    const result = await invokeMcpLambdaTool({ kind, tool, args, connConfig });
    return json({ result: normalizeResult(kind, tool, result) }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'query failed' }, 502);
  }
}
