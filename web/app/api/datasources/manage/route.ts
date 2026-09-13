// POST (create) / PATCH (update) a datasource instance. Admin-gated. Persists the row via
// datasources.ts and the credential (flat connConfig blob) under the instance id. When the instance is
// (or becomes) the default for its kind, the kind-mirror credential is refreshed so the agent gateway
// no-inline path resolves to it. SECURITY: the credential value is never logged or echoed.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { createDatasource, updateDatasource, getDatasource, withDatasourceLock } from '@/lib/datasources';
import { setIntegrationCredentialById, mirrorDefaultCredential, getIntegrationCredentialSnapshot } from '@/lib/integration-credentials';
import { isDatasourceKind } from '@/lib/integrations-category';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { invokeMcpLambdaTool, type ConnConfig } from '@/lib/mcp-lambda-invoke';
import { upsertSchema } from '@/lib/datasource-schema';
import { enqueueDatasourceIndex } from '@/lib/diag-signals';
import { currentAccountId } from '@/lib/account';
import { effectiveSavedConnection, mergeDatasourceConnection, ConnectionInputError, object } from '@/lib/datasource-connection';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** §3.C connect-time: warm the schema+version cache best-effort so chat/diag never depend on a manual
 *  "Refresh schema". Fire-and-forget — the web tier is long-lived Fargate (not Lambda), so this runs
 *  after the response; a failure logs (name only — never the credential) and leaves manual Refresh. */
function warmSchemaCache(id: number, kind: string, connConfig: ConnConfig): void {
  void (async () => {
    try {
      const schema = await invokeMcpLambdaTool({ kind, tool: `${kind}_schema`, connConfig });
      await upsertSchema(currentAccountId(), id, kind, schema);
      await enqueueDatasourceIndex(id, kind);  // rebuild pre-built diagnostic signals (prom/mimir; best-effort)
    } catch (e) {
      console.warn('[datasources] connect-time introspect failed (manual Refresh remains):', (e as { name?: string })?.name || 'error');
    }
  })();
}

async function gate(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return { resp: json({ error: 'unauthenticated' }, 401) };
  if (!(await isAdmin(user))) return { resp: json({ error: 'admin access required' }, 403) };
  if (!process.env.AURORA_ENDPOINT) return { resp: json({ error: 'Aurora not configured' }, 400) };
  return {};
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const body = await readJsonBounded(request);
  if (!object(body)) throw new ConnectionInputError('body must be an object');
  return body;
}
function failure(e: unknown) {
  if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
  if (e instanceof ConnectionInputError) return json({ error: e.message }, 400);
  if (e instanceof SyntaxError) return json({ error: 'invalid JSON body' }, 400);
  if (/duplicate/i.test((e as Error)?.message ?? '')) return json({ error: 'duplicate datasource name' }, 409);
  return json({ error: 'Unable to save datasource configuration. Retry or check access.' }, 400);
}

export async function POST(request: Request) {
  const g = await gate(request); if (g.resp) return g.resp;
  try {
    const body = await parseBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const kind = typeof body.kind === 'string' ? body.kind : '';
    if (!name) return json({ error: 'name required' }, 400);
    if (!isDatasourceKind(kind)) return json({ error: 'unknown datasource kind' }, 400);
    const blob = mergeDatasourceConnection(kind, body);
    const settings = { ...(blob.timeoutS !== undefined ? { timeoutS: blob.timeoutS } : {}), ...(blob.database ? { database: blob.database } : {}) };
    const id = await createDatasource({ name, kind, endpoint: blob.endpoint, authType: blob.authType, settings });
    await setIntegrationCredentialById(id, blob);
    const ds = await getDatasource(id);
    if (ds?.isDefault) await mirrorDefaultCredential(kind, blob);
    warmSchemaCache(id, kind, blob);
    return json({ id }, 201);
  } catch (e) { return failure(e); }
}

export async function PATCH(request: Request) {
  const g = await gate(request); if (g.resp) return g.resp;
  try {
    const body = await parseBody(request);
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'valid id required' }, 400);
    // Resolve and merge inside the existing per-instance lock. Test uses the same helper.
    return await withDatasourceLock(id, async client => {
      const ds = await getDatasource(id, client);
      if (!ds || !isDatasourceKind(ds.kind)) return json({ error: 'datasource not found' }, 404);
      const saved = effectiveSavedConnection(ds, await getIntegrationCredentialSnapshot());
      const blob = mergeDatasourceConnection(ds.kind, body, saved);
      const settings = { ...(blob.timeoutS !== undefined ? { timeoutS: blob.timeoutS } : {}), ...(blob.database ? { database: blob.database } : {}) };
      const name = typeof body.name === 'string' ? body.name.trim() : undefined;
      // Preflight the only unique field before touching Secrets Manager.
      if (name !== undefined && name !== ds.name) await updateDatasource(id, { name }, client);
      await setIntegrationCredentialById(id, blob, client);
      if (ds.isDefault) await mirrorDefaultCredential(ds.kind, blob, client);
      // Persist inferred fields too: a successful Test must not become auth=none on Save.
      await updateDatasource(id, { endpoint: blob.endpoint, authType: blob.authType, settings }, client);
      if ((settings.database ?? null) !== (ds.settings?.database ?? null)) warmSchemaCache(id, ds.kind, blob);
      return json({ ok: true }, 200);
    });
  } catch (e) { return failure(e); }
}
