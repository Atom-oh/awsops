// GET /api/datasources — list configured datasource INSTANCES for the hub + Explore picker.
// Authenticated (read-only), NOT admin. Returns {id,name,kind,authType,isDefault,connected} — never
// credentials. Configuration presence is not a connectivity probe. Read failures
// carry available:false so consumers distinguish unavailable from an empty inventory.
import { verifyUser } from '@/lib/auth';
import { listDatasources } from '@/lib/datasources';
import { isAdmin } from '@/lib/admin';
import { getIntegrationCredentialSnapshot } from '@/lib/integration-credentials';
import { datasourceConnectionMetadata } from '@/lib/datasource-connection';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  try {
    const [rows, snapshot, admin] = await Promise.all([listDatasources(), getIntegrationCredentialSnapshot(), isAdmin(user)]);
    const datasources = rows.map(r => {
      const meta = datasourceConnectionMetadata(r, snapshot);
      return {
        id: r.id, name: r.name, kind: r.kind, authType: meta.authType,
        isDefault: r.isDefault, enabled: r.enabled,
        ...(admin ? { endpoint: meta.endpoint, settings: r.settings } : {}),
        connected: meta.connected, configurationStatus: meta.configurationStatus,
      };
    });
    return json({ datasources, available: true }, 200);
  } catch {
    return json({ datasources: [], available: false, error: 'Datasource configuration is unavailable. Retry or ask an administrator to check access.' }, 200);
  }
}
