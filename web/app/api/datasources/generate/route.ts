// POST /api/datasources/generate — natural-language → datasource query (Explore "AI로 생성").
// Authenticated. Drafts a query string for the user to REVIEW then run — it NEVER executes anything.
//
// Bedrock-DIRECT (web/lib/datasource-querygen) — NOT the AgentCore monitoring gateway. Routing this
// through the section agent appended the 24-tool list + COMMON_FOOTER ("respond in markdown") after the
// thin "output a query" instruction and bound the tools, so the agent answered in PROSE instead of
// emitting SQL (then the prose was rejected by the read-only guard on run). Here: no tools, no footer,
// a strict translate-to-query prompt + the schema (real table/COLUMN names) injected as data.
import { verifyUser } from '@/lib/auth';
import { generateQuery } from '@/lib/datasource-querygen';
import { listConfiguredSchemas, renderSchemaForPrompt, upsertSchema } from '@/lib/datasource-schema';
import { currentAccountId } from '@/lib/account';
import { getDatasource, resolveConnConfig, type DatasourceRow } from '@/lib/datasources';
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { isDatasourceKind } from '@/lib/integrations-category';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LANG: Record<string, string> = {
  prometheus: 'PromQL', mimir: 'PromQL', loki: 'LogQL', tempo: 'TraceQL', clickhouse: 'read-only SQL',
};
const MAX_NL = 4_000;

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** Resolve a prompt-ready schema block: cached schema first (per-instance, else any of this kind); if
 *  the connect-time warm never ran / failed, introspect ON DEMAND for an instance and self-heal the
 *  cache. Best-effort throughout — generation still proceeds schema-less (the model is told as much). */
async function resolveSchemaBlock(ds: DatasourceRow | null, id: number, hasId: boolean, kind: string): Promise<string> {
  const accountId = currentAccountId();
  try {
    const schemas = await listConfiguredSchemas(accountId);
    const own = (hasId ? schemas.find((s) => s.integrationId === id) : undefined) || schemas.find((s) => s.kind === kind);
    if (own?.schema) {
      const block = renderSchemaForPrompt(own.schema, own.kind);
      if (block) return block;
    }
  } catch { /* cache is optional */ }

  if (hasId && ds) {
    try {
      const connConfig = await resolveConnConfig(ds);
      if (connConfig?.endpoint) assertDatasourceEndpointAllowed(connConfig.endpoint); // defense-in-depth (connector guards too)
      const schema = await invokeMcpLambdaTool({ kind, tool: `${kind}_schema`, connConfig });
      try { await upsertSchema(accountId, id, kind, schema); } catch { /* cache write best-effort */ }
      return renderSchemaForPrompt(schema, kind);
    } catch { /* introspect best-effort; proceed schema-less */ }
  }
  return '';
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  let body: { id?: unknown; slug?: unknown; kind?: unknown; nl?: unknown };
  try { body = (await readJsonBounded(request)) as typeof body; }
  catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }

  // Resolve the kind: by instance id (preferred) or by slug/kind (deprecated).
  let kind = '';
  let ds: DatasourceRow | null = null;
  const id = Number(body.id);
  const hasId = Number.isInteger(id) && id > 0;
  if (hasId) {
    ds = await getDatasource(id);
    if (!ds) return json({ error: 'unknown datasource instance' }, 400);
    kind = ds.kind;
  } else {
    kind = typeof body.kind === 'string' && body.kind ? body.kind : (typeof body.slug === 'string' ? body.slug : '');
  }
  if (!isDatasourceKind(kind)) return json({ error: 'unknown datasource' }, 400);

  const lang = LANG[kind] || 'query';
  const isSql = /SQL/i.test(lang);
  const nl = typeof body.nl === 'string' ? body.nl.trim().slice(0, MAX_NL) : '';
  if (!nl) return json({ error: 'nl (natural-language request) required' }, 400);

  const schemaBlock = await resolveSchemaBlock(ds, id, hasId, kind);

  try {
    const query = await generateQuery({ nl, lang, schemaBlock, isSql });
    return json({ query, lang }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'generation failed' }, 502);
  }
}
