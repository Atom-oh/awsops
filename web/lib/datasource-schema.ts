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
  version: string | null; // captured server version (e.g. "2.48.0") for version-aware query generation
  fetched_at: string;
}

/** Pull the best-effort server version out of the introspected schema JSON (connectors store it under
 *  `schema.version`; null when the connector couldn't fetch buildinfo). */
function schemaVersion(schema: unknown): string | null {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const v = (schema as Record<string, unknown>).version;
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function mapRow(r: Record<string, unknown>): CachedSchema {
  return {
    // BIGINT integration_id comes back from node-pg as a STRING — coerce so it matches the numeric
    // datasource id (chat injection keys schemas by integrationId and looks them up by datasource id).
    integrationId: Number(r.integration_id),
    kind: (r.kind as string) ?? null,
    schema: r.schema,
    version: schemaVersion(r.schema),
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

// --- Prompt rendering -------------------------------------------------------
// Bounds so a rich introspected schema (ClickHouse allows up to 100 tables × 200 cols) never blows the
// model prompt. Tuned to fit comfortably inside the agent's 8000-char extraContext budget.
const PROMPT_MAX_TABLES = 40;
const PROMPT_MAX_COLS = 60;
const PROMPT_MAX_CHARS = 6000;

/**
 * Render a cached datasource schema into a compact, prompt-ready block.
 *
 * For SQL datasources (the introspected schema carries `tables: [{name, columns: [{name, type}]}]`),
 * it emits `table(col type, col type, …)` — so the model sees the COLUMNS, not just table names, which
 * is what it needs to write a real query (the previous renderer dropped columns → the model couldn't
 * write a correct ClickHouse query). For metric/label/tag datasources (Prometheus/Loki/Tempo) it emits
 * `key: name, name, …` (names are all those carry). Bounded by tables, columns, and total chars.
 */
export function renderSchemaForPrompt(schema: unknown, _kind?: string | null): string {
  const s = (schema && typeof schema === 'object' && !Array.isArray(schema)) ? (schema as Record<string, unknown>) : {};
  const lines: string[] = [];
  let budget = PROMPT_MAX_CHARS; // running char budget so truncation is explicit, never a blind slice()

  // SQL datasources: tables WITH columns + types (the part the model actually needs for SQL).
  if (Array.isArray(s.tables) && s.tables.length) {
    const tables = s.tables as unknown[];
    const considered = tables.slice(0, PROMPT_MAX_TABLES);
    let emitted = 0;
    let budgetBroke = false;
    for (const t of considered) {
      if (!t || typeof t !== 'object') continue;
      const tt = t as { name?: unknown; columns?: unknown };
      const name = typeof tt.name === 'string' ? tt.name : '';
      if (!name) continue;
      const cols = Array.isArray(tt.columns) ? (tt.columns as unknown[]).slice(0, PROMPT_MAX_COLS) : [];
      const colStr = cols
        .map((c) => {
          if (typeof c === 'string') return c;
          const cc = (c || {}) as { name?: unknown; type?: unknown };
          const cn = typeof cc.name === 'string' ? cc.name : '';
          const ct = typeof cc.type === 'string' ? cc.type : '';
          return cn ? (ct ? `${cn} ${ct}` : cn) : '';
        })
        .filter(Boolean)
        .join(', ');
      const line = colStr ? `${name}(${colStr})` : name;
      // Reserve ~60 chars for the truncation-disclosure line; stop cleanly rather than slice mid-table.
      if (lines.length && line.length + 1 > budget - 60) { budgetBroke = true; break; }
      lines.push(line);
      budget -= line.length + 1;
      emitted += 1;
    }
    // Disclose truncation ONLY when a real limit (MAX_TABLES cap or char budget) dropped content —
    // a silent cap would read to the model as "these are all the tables" when they are not. (When the
    // whole `tables` array was malformed, emitted === 0 and we disclose nothing.)
    const limitHit = tables.length > PROMPT_MAX_TABLES || budgetBroke;
    if (emitted > 0 && limitHit) {
      lines.push(`… (+${tables.length - emitted} more tables — refine the request or query system.tables)`);
    }
  }

  // metric/label/tag/domain/index datasources: names only (that's all they carry).
  const names = (a: unknown, n: number) =>
    (Array.isArray(a) ? a : [])
      .slice(0, n)
      .map((x) => (typeof x === 'string' ? x : ((x as { name?: string })?.name ?? '')))
      .filter(Boolean)
      .join(', ');
  for (const [k, n] of [['metrics', 80], ['labels', 80], ['tags', 80], ['domains', 20], ['indices', 60]] as const) {
    if (Array.isArray(s[k]) && (s[k] as unknown[]).length) {
      const line = `${k}: ${names(s[k], n)}`;
      if (line.length + 1 > budget) continue;
      lines.push(line);
      budget -= line.length + 1;
    }
  }

  return lines.join('\n');
}
