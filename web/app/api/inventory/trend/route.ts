import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

interface TrendPoint { date: string; total: number; ec2: number }

/**
 * Daily resource-count trend (dashboard "리소스 추세" chart) from inventory_snapshots —
 * one row per (day, resource_type), written by sync_lambda's _self_count on every sync.
 * account_id='self' only, matching every other host-facing inventory read. History only
 * exists from whenever the sync Lambda first wrote a snapshot (steampipe_enabled deploys);
 * days before that simply have no row.
 */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || DEFAULT_DAYS));
  try {
    const pool = getPool();
    const r = await pool.query<{ d: string; resource_type: string; n: number }>(
      `SELECT captured_at::date::text AS d, resource_type, SUM(resource_count)::int AS n
       FROM inventory_snapshots
       WHERE account_id = 'self' AND captured_at >= now() - ($1 || ' days')::interval
       GROUP BY 1, 2 ORDER BY 1`,
      [days],
    );
    const byDate = new Map<string, TrendPoint>();
    for (const row of r.rows) {
      const p = byDate.get(row.d) ?? { date: row.d, total: 0, ec2: 0 };
      p.total += Number(row.n);
      if (row.resource_type === 'ec2') p.ec2 = Number(row.n);
      byDate.set(row.d, p);
    }
    const trend = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    return Response.json({ trend });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
