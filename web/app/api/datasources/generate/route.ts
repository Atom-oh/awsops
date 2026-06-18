// POST /api/datasources/generate — natural-language → datasource query (v1 explore parity).
// Authenticated. Calls the monitoring agent with a QUERY-ONLY prompt + the connector's cached schema,
// and returns the generated query string for the user to REVIEW then run. It never executes anything.
import { randomUUID } from 'crypto';
import { verifyUser } from '@/lib/auth';
import { invokeAgent } from '@/lib/agentcore';
import { listConfiguredSchemas } from '@/lib/datasource-schema';
import { currentAccountId } from '@/lib/account';
import { getDatasource } from '@/lib/datasources';
import { isDatasourceKind } from '@/lib/integrations-category';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LANG: Record<string, string> = {
  prometheus: 'PromQL', mimir: 'PromQL', loki: 'LogQL', tempo: 'TraceQL', clickhouse: 'read-only SQL',
};
const MAX_NL = 4_000;
const MAX_QUERY = 8_000;

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** Compact schema block (real names only) so the model writes a query against the actual datasource. */
function schemaContext(schema: unknown): string {
  const s = (schema || {}) as Record<string, unknown>;
  const names = (a: unknown, n: number) =>
    (Array.isArray(a) ? a : []).slice(0, n).map((x) => (typeof x === 'string' ? x : (x as { name?: string }).name ?? '')).filter(Boolean).join(', ');
  const parts: string[] = [];
  for (const [k, n] of [['metrics', 60], ['labels', 60], ['tags', 60], ['tables', 40], ['domains', 10], ['indices', 40]] as const) {
    if (Array.isArray(s[k]) && (s[k] as unknown[]).length) parts.push(`${k}: ${names(s[k], n)}`);
  }
  return parts.length ? `## Datasource schema (cached — use these real names)\n${parts.join('\n')}` : '';
}

// Per-language syntax guidance + canonical examples. The model was previously given only the language NAME,
// so it free-associated PromQL/LogQL grammar and hallucinated metric names → wrong, nonsensical queries.
const LANG_GUIDE: Record<string, string> = {
  PromQL: [
    'PromQL: use `rate(metric_total[5m])` for counters, `sum by (label)(...)` to aggregate,',
    '`histogram_quantile(0.99, sum by (le)(rate(metric_bucket[5m])))` for percentiles,',
    '`100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100` for CPU%.',
    'Counters need a range window like `[5m]` inside rate()/increase(); pick metric names from the schema `metrics:` list and label names from `labels:`.',
  ].join(' '),
  LogQL: [
    'LogQL: always begin with a stream selector `{label="value"}` (labels from the schema `labels:` list),',
    'then line filters `|= "x"` / `|~ "(?i)error"`; aggregate with `count_over_time({app="api"} |~ "(?i)error" [5m])`',
    'or `sum by (level)(count_over_time({namespace="prod"}[5m]))`.',
  ].join(' '),
  TraceQL: [
    'TraceQL: filter spans with `{ status = error }` or `{ duration > 500ms && resource.service.name = "api" }`;',
    'use attribute/tag names from the schema when provided.',
  ].join(' '),
  'read-only SQL': 'The query MUST be read-only — it must START with SELECT, WITH, SHOW, or DESCRIBE; use table/column names from the schema `tables:` list.',
};

function queryOnlyPrompt(lang: string): string {
  return [
    `You translate a natural-language request into a single ${lang} query.`,
    `Output ONLY the query inside one fenced code block — no explanation, no prose, no multiple queries.`,
    LANG_GUIDE[lang] || '',
    `The metric/label/table names shown in the examples above are ILLUSTRATIVE syntax only — never copy them into the output.`,
    `Use ONLY names present in the provided datasource schema. If NO schema is provided, do NOT invent real metric/table/label names — write a generic ${lang} skeleton with obvious placeholder names (e.g. <metric_name>) the user can replace, since the schema must be refreshed first.`,
  ].filter(Boolean).join(' ');
}

/** First fenced code block, else the trimmed whole text. */
function extractQuery(text: string): string {
  const m = text.match(/```[\w-]*\n?([\s\S]*?)```/);
  const q = (m ? m[1] : text).trim();
  return q.slice(0, MAX_QUERY);
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

  // Resolve the kind: by instance id (preferred) or by slug/kind (deprecated). This route only drafts a
  // query via the agent — it never invokes a connector, so no inline conn-config is needed.
  let kind = '';
  const id = Number(body.id);
  if (Number.isInteger(id) && id > 0) {
    const ds = await getDatasource(id);
    if (!ds) return json({ error: 'unknown datasource instance' }, 400);
    kind = ds.kind;
  } else {
    kind = typeof body.kind === 'string' && body.kind ? body.kind : (typeof body.slug === 'string' ? body.slug : '');
  }
  if (!isDatasourceKind(kind)) return json({ error: 'unknown datasource' }, 400);
  const lang = LANG[kind] || 'query';
  const nl = typeof body.nl === 'string' ? body.nl.trim().slice(0, MAX_NL) : '';
  if (!nl) return json({ error: 'nl (natural-language request) required' }, 400);

  const hasId = Number.isInteger(id) && id > 0;
  let extraContext = '';
  try {
    const schemas = await listConfiguredSchemas(currentAccountId());
    // Prefer this instance's cached schema (keyed by integration_id); else best-effort by kind.
    const own = (hasId && schemas.find((s) => s.integrationId === id)) || schemas.find((s) => s.kind === kind);
    if (own) extraContext = schemaContext(own.schema);
  } catch { /* schema is optional — the model can still generate a best-effort query */ }

  try {
    const text = await invokeAgent({
      gateway: 'monitoring',
      messages: [{ role: 'user', content: nl }],
      systemPromptOverride: queryOnlyPrompt(lang),
      extraContext: extraContext || undefined,
      sessionId: `datasrc-gen-${randomUUID()}`, // ≥33 chars
    });
    return json({ query: extractQuery(String(text ?? '')), lang }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'generation failed' }, 502);
  }
}
