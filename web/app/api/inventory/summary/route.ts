import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { INVENTORY_TYPES } from '@/lib/inventory-types';

export const dynamic = 'force-dynamic';

interface ByType { type: string; label: string; count: number }
interface ByCategory { group: string; count: number }

/** Aggregate inventory counts: per resource_type (desc) and rolled up per category group. */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const pool = getPool();
    const r = await pool.query<{ resource_type: string; n: number }>(
      `SELECT resource_type, count(*)::int AS n FROM inventory_resources
       WHERE account_id = 'self' GROUP BY resource_type`,
    );
    const byType: ByType[] = r.rows
      .map((row) => ({
        type: row.resource_type,
        label: INVENTORY_TYPES[row.resource_type]?.label ?? row.resource_type,
        count: Number(row.n),
      }))
      .sort((a, b) => b.count - a.count);
    const groups = new Map<string, number>();
    for (const row of r.rows) {
      const group = INVENTORY_TYPES[row.resource_type]?.group ?? 'Other';
      groups.set(group, (groups.get(group) ?? 0) + Number(row.n));
    }
    const byCategory: ByCategory[] = [...groups.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count);
    const total = byType.reduce((s, x) => s + x.count, 0);
    return Response.json({ byType, byCategory, total });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
