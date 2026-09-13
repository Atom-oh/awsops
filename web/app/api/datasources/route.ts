// GET /api/datasources — list configured datasource INSTANCES for the hub + Explore picker.
// Authenticated (read-only), NOT admin. Returns {id,name,kind,authType,isDefault,connected} — never
// credentials. Configuration presence is not a connectivity probe. Read failures
// carry available:false so consumers distinguish unavailable from an empty inventory.
import { verifyUser } from '@/lib/auth';
import { listDatasources } from '@/lib/datasources';
import { isAdmin } from '@/lib/admin';
import { getConfiguredIds } from '@/lib/integration-credentials';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  try {
    const [rows, configuredIds, admin] = await Promise.all([listDatasources(), getConfiguredIds(true), isAdmin(user)]);
    const idSet = new Set(configuredIds);
    const datasources = rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      // Connection detail is admin-only (v1 showed the URL; v2 keeps it off the read-any shape).
      // settings ride the same admin-only visibility as the endpoint (gap L203)
      ...(admin ? { endpoint: r.endpoint, settings: r.settings } : {}),
      authType: r.authType,
      isDefault: r.isDefault,
      enabled: r.enabled,
      // Keep the legacy field for existing consumers. It means saved configuration,
      // never live connectivity; a default flag does not establish credential presence.
      connected: idSet.has(String(r.id)) || (Boolean(r.endpoint) && r.authType === 'none'),
      configurationStatus: idSet.has(String(r.id)) || (Boolean(r.endpoint) && r.authType === 'none') ? 'stored' : 'missing',
    }));
    return json({ datasources, available: true }, 200);
  } catch {
    return json({ datasources: [], available: false, error: 'Datasource configuration is unavailable. Retry or ask an administrator to check access.' }, 200);
  }
}
