// GET /api/datasources — list configured QUERYABLE datasources for the Explore page.
// Authenticated (read-only exploration), NOT admin. Returns slug/kind/hasSchema only — never credentials.
import { verifyUser } from '@/lib/auth';
import { getConfiguredSlugs } from '@/lib/integration-credentials';
import { listConfiguredSchemas } from '@/lib/datasource-schema';
import { currentAccountId } from '@/lib/account';
import { QUERYABLE_KINDS } from './query/route';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  const configured = await getConfiguredSlugs(); // slugs with credentials in the secret (keys only)
  let withSchema = new Set<string>();
  try {
    const schemas = await listConfiguredSchemas(currentAccountId());
    withSchema = new Set(schemas.map((s) => s.slug));
  } catch { /* schema cache is best-effort; the dropdown still works without the hint */ }

  const datasources = configured
    .filter((slug) => (QUERYABLE_KINDS as readonly string[]).includes(slug))
    .map((slug) => ({ slug, kind: slug, hasSchema: withSchema.has(slug) }));

  return json({ datasources }, 200);
}
