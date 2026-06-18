// web/lib/datasource-schema.ts
// Durable cache of introspected datasource schemas (Aurora `datasource_schemas`). The hub "Refresh
// schema" route writes here (via the connector Lambda's <kind>_schema tool); the chat route reads here
// to inject a compact schema block into the agent payload (the agent reads the cache, not the live
// datasource). Keyed PER INSTANCE by (account_id, integration_id) so two instances of one kind don't
// share a cache row (the PK was swapped from (account_id, slug) by the datasource-instances migration).
import { getPool } from '@/lib/db';

const MAX_SCHEMA_BYTES = 256_000; // bound a single cached schema (Aurora row + later prompt injection)

export interface CachedSchema {
  integrationId: number;
  kind: string | null;
  schema: unknown;
  fetched_at: string;
}

function mapRow(r: Record<string, unknown>): CachedSchema {
  return {
    // BIGINT integration_id comes back from node-pg as a STRING — coerce so it matches the numeric
    // datasource id (chat injection keys schemas by integrationId and looks them up by datasource id).
    integrationId: Number(r.integration_id),
    kind: (r.kind as string) ?? null,
    schema: r.schema,
    fetched_at: r.fetched_at as string,
  };
}

export async function upsertSchema(accountId: string, integrationId: number, kind: string | null, schema: unknown): Promise<void> {
  const json = JSON.stringify(schema ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error('introspected schema exceeds size limit');
  }
  await getPool().query(
    `INSERT INTO datasource_schemas (account_id, integration_id, kind, schema, fetched_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (account_id, integration_id)
     DO UPDATE SET kind = EXCLUDED.kind, schema = EXCLUDED.schema, fetched_at = now()`,
    [accountId, integrationId, kind, json],
  );
}

export async function getSchema(accountId: string, integrationId: number): Promise<CachedSchema | null> {
  const { rows } = await getPool().query(
    'SELECT integration_id, kind, schema, fetched_at FROM datasource_schemas WHERE account_id = $1 AND integration_id = $2',
    [accountId, integrationId],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listConfiguredSchemas(accountId: string): Promise<CachedSchema[]> {
  const { rows } = await getPool().query(
    'SELECT integration_id, kind, schema, fetched_at FROM datasource_schemas WHERE account_id = $1 ORDER BY integration_id',
    [accountId],
  );
  return rows.map(mapRow);
}
