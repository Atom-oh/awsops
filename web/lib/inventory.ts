import { getPool } from '@/lib/db';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let lambda: LambdaClient | null = null;
function lambdaClient(): LambdaClient { if (!lambda) lambda = new LambdaClient({ region: REGION }); return lambda; }

export interface SyncRun { status: string; finished_at: string | null; row_count: number | null; error?: string | null }
export interface InventoryPage { rows: Record<string, unknown>[]; run: SyncRun | null }

export interface ReadResourcesOpts {
  limit: number;
  offset: number;
  /** Region allow-list, or '__all__' (default) for no region filter. */
  regions?: string[] | '__all__';
  /** Include region='global' rows (IAM, Route53, ...). Default true. */
  includeGlobal?: boolean;
}

export async function readResources(type: string, { limit, offset, regions = '__all__', includeGlobal = true }: ReadResourcesOpts): Promise<InventoryPage> {
  const pool = getPool();
  // Build the allowed-region array once (co-agent panel: ANY() over an array beats an OR clause,
  // and folding includeGlobal into the array itself means it isn't silently dropped when
  // regions === '__all__' — the old OR-based draft only checked includeGlobal in the non-'__all__' branch).
  let where = `resource_type = $1 AND account_id = 'self'`;
  const params: unknown[] = [type];
  if (regions !== '__all__') {
    const allowed = includeGlobal ? [...regions, 'global'] : regions;
    params.push(allowed.length ? allowed : ['__none__']); // empty selection → empty result, not unfiltered
    where += ` AND region = ANY($${params.length})`;
  } else if (!includeGlobal) {
    where += ` AND region <> 'global'`;
  }
  params.push(limit, offset);
  const r = await pool.query(
    `SELECT resource_id, region, data, captured_at FROM inventory_resources
     WHERE ${where} ORDER BY captured_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const s = await pool.query(
    `SELECT status, finished_at, row_count, error FROM inventory_sync_runs WHERE resource_type = $1 AND account_id = 'self'`,
    [type],
  );
  return { rows: r.rows, run: s.rows[0] ?? null };
}

export async function triggerSync(type: string): Promise<{ status: string; row_count?: number; error?: string }> {
  const fn = process.env.INV_SYNC_FUNCTION;
  if (!fn) throw new Error('INV_SYNC_FUNCTION not set');
  const out = await lambdaClient().send(new InvokeCommand({
    FunctionName: fn,
    Payload: new TextEncoder().encode(JSON.stringify({ type })),
  }));
  const raw = out.Payload ? new TextDecoder().decode(out.Payload) : '{}';
  try { return JSON.parse(raw); } catch { return { status: 'unknown' }; }
}
