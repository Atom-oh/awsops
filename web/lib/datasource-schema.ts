// web/lib/datasource-schema.ts
// Durable cache of introspected datasource schemas (Aurora `datasource_schemas`). The Connectors UI
// "Refresh schema" route writes here (via the connector Lambda's <ds>_schema tool); the chat route
// reads here to inject a compact schema block into the agent payload (the agent reads the cache, not
// the live datasource). Account-scoped by the (account_id, slug) PK.
import { getPool } from '@/lib/db';

const MAX_SCHEMA_BYTES = 256_000; // bound a single cached schema (Aurora row + later prompt injection)

export interface CachedSchema {
  slug: string;
  kind: string | null;
  schema: unknown;
  fetched_at: string;
}

export async function upsertSchema(accountId: string, slug: string, kind: string | null, schema: unknown): Promise<void> {
  const json = JSON.stringify(schema ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error('introspected schema exceeds size limit');
  }
  await getPool().query(
    `INSERT INTO datasource_schemas (account_id, slug, kind, schema, fetched_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (account_id, slug)
     DO UPDATE SET kind = EXCLUDED.kind, schema = EXCLUDED.schema, fetched_at = now()`,
    [accountId, slug, kind, json],
  );
}

export async function getSchema(accountId: string, slug: string): Promise<CachedSchema | null> {
  const { rows } = await getPool().query(
    'SELECT slug, kind, schema, fetched_at FROM datasource_schemas WHERE account_id = $1 AND slug = $2',
    [accountId, slug],
  );
  return (rows[0] as CachedSchema) ?? null;
}

export async function listConfiguredSchemas(accountId: string): Promise<CachedSchema[]> {
  const { rows } = await getPool().query(
    'SELECT slug, kind, schema, fetched_at FROM datasource_schemas WHERE account_id = $1 ORDER BY slug',
    [accountId],
  );
  return rows as CachedSchema[];
}
