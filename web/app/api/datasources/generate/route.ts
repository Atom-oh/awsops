// POST /api/datasources/generate — natural-language → datasource query (v1 explore parity).
// Authenticated. Calls the monitoring agent with a QUERY-ONLY prompt + the connector's cached schema,
// and returns the generated query string for the user to REVIEW then run. It never executes anything.
import { randomUUID } from 'crypto';
import { verifyUser } from '@/lib/auth';
import { invokeAgent } from '@/lib/agentcore';
import { listConfiguredSchemas } from '@/lib/datasource-schema';
import { currentAccountId } from '@/lib/account';
import { KNOWN_CONNECTOR_SLUGS } from '@/lib/integration-credentials';

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

function queryOnlyPrompt(lang: string): string {
  return [
    `You translate a natural-language request into a single ${lang} query.`,
    `Output ONLY the query inside one fenced code block. No explanation, no prose, no multiple queries.`,
    `Use ONLY names present in the provided datasource schema when one is given.`,
    lang.includes('SQL') ? `The query MUST be read-only (SELECT/SHOW/DESCRIBE only).` : '',
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

  let body: { slug?: unknown; kind?: unknown; nl?: unknown };
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }

  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!(KNOWN_CONNECTOR_SLUGS as readonly string[]).includes(slug)) return json({ error: 'unknown datasource' }, 400);
  const kind = typeof body.kind === 'string' && body.kind ? body.kind : slug;
  const lang = LANG[kind] || LANG[slug] || 'query';
  const nl = typeof body.nl === 'string' ? body.nl.trim().slice(0, MAX_NL) : '';
  if (!nl) return json({ error: 'nl (natural-language request) required' }, 400);

  let extraContext = '';
  try {
    const schemas = await listConfiguredSchemas(currentAccountId());
    const own = schemas.find((s) => s.slug === slug);
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
