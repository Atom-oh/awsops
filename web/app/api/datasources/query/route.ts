// POST /api/datasources/query — execute a read-only query against a configured datasource connector.
// Authenticated (read-only exploration), NOT admin. The connector Lambda owns SSRF/auth/read-only
// enforcement; this route only resolves the tool, forwards via invokeConnectorTool, and normalizes.
// SECURITY: TOOL holds ONLY read tools (no mutate is reachable) — AWS-mutation/autonomy stays frozen.
import { verifyUser } from '@/lib/auth';
import { invokeConnectorTool } from '@/lib/connector-invoke';
import { KNOWN_CONNECTOR_SLUGS } from '@/lib/integration-credentials';
import { normalizeResult } from '@/lib/datasource-render';

export const dynamic = 'force-dynamic';

const MAX_QUERY = 8_000;
const CLICKHOUSE_MAX_ROWS = 500;

interface ToolSpec { instant: string; range?: string; arg: 'query' | 'sql'; extra?: Record<string, unknown> }

// Explicit per-kind map (NOT a formula — tempo has no *_query/_query_range, only tempo_search).
// Every value is a read tool. The test asserts this invariant.
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

  let body: { slug?: unknown; query?: unknown; range?: unknown };
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }

  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!(KNOWN_CONNECTOR_SLUGS as readonly string[]).includes(slug)) return json({ error: 'unknown datasource' }, 400);
  const spec = TOOL[slug]; // kind == slug for these connectors
  if (!spec) return json({ error: `datasource '${slug}' is not queryable` }, 400);

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return json({ error: 'query required' }, 400);
  if (query.length > MAX_QUERY) return json({ error: 'query too large' }, 413);

  const tool = body.range === true && spec.range ? spec.range : spec.instant;
  const args: Record<string, unknown> = { [spec.arg]: query, ...(spec.extra ?? {}) };

  try {
    const result = await invokeConnectorTool(slug, tool, args);
    return json({ result: normalizeResult(slug, tool, result) }, 200);
  } catch (e) {
    // message only — connector messages never carry the credential value
    return json({ error: e instanceof Error ? e.message : 'query failed' }, 502);
  }
}
