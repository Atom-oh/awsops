// Admin schema refresh/read for datasource connectors. POST introspects a connector (invokes its
// <slug>_schema tool) and caches the result in Aurora; GET returns cached summaries. The agent reads
// the cache via the chat route (not here). accountId is server-derived (never the request body).
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { currentAccountId } from '@/lib/account';
import { invokeConnectorTool } from '@/lib/connector-invoke';
import { upsertSchema, listConfiguredSchemas } from '@/lib/datasource-schema';
import { KNOWN_CONNECTOR_SLUGS } from '@/lib/integration-credentials';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function gate(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return { resp: json({ error: 'unauthenticated' }, 401) };
  if (!(await isAdmin(user))) return { resp: json({ error: 'admin access required' }, 403) };
  if (!process.env.AURORA_ENDPOINT) return { resp: json({ error: 'Aurora not configured' }, 400) };
  return { user };
}

/** Counts only — never the introspected values themselves. */
function summarize(schema: unknown): Record<string, number> {
  const s = (schema || {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of ['tables', 'metrics', 'labels', 'tags', 'domains', 'indices'] as const) {
    if (Array.isArray(s[k])) out[k] = (s[k] as unknown[]).length;
  }
  return out;
}

export async function POST(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  let body: { slug?: unknown };
  try { body = (await readJsonBounded(request)) as typeof body; } // bound BEFORE parse (OOM guard)
  catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!slug || !(KNOWN_CONNECTOR_SLUGS as readonly string[]).includes(slug)) {
    return json({ error: 'valid connector slug required' }, 400);
  }
  const accountId = currentAccountId(); // server-side; never the request body
  try {
    const schema = await invokeConnectorTool(slug, `${slug}_schema`, {});
    await upsertSchema(accountId, slug, slug, schema);
    return json({ ok: true, slug, summary: summarize(schema) }, 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

export async function GET(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  const rows = await listConfiguredSchemas(currentAccountId());
  return json({ schemas: rows.map((r) => ({ slug: r.slug, kind: r.kind, fetched_at: r.fetched_at, summary: summarize(r.schema) })) }, 200);
}
