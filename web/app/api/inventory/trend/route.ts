import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

interface TrendPoint { date: string; total: number; ec2?: number }

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
    const byDate = new Map<string, TrendPoint & Record<string, number | string>>();
    const latestByType = new Map<string, number>();
    for (const row of r.rows) {
      // NO per-type pre-seeding (the old `ec2: 0` seed made a failed EC2 sync day
      // indistinguishable from a genuine zero — key ABSENCE is the coverage signal the
      // client's coverage-parity diff and the ranking below both rely on).
      const p = byDate.get(row.d) ?? { date: row.d, total: 0 };
      p.total += Number(row.n);
      // v1 parity: every type is a column on the point (multi-line chart + delta table).
      p[row.resource_type] = Number(row.n);
      byDate.set(row.d, p);
      latestByType.set(row.resource_type, Number(row.n)); // rows are date-ordered → last write wins
    }
    const trend = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    // Types ranked by the LATEST DAY's counts; a type ABSENT from the latest day (stopped
    // syncing / failed slice) ranks below every present type — never holding a Core slot on
    // a stale count — with its last-seen value only as the tie-break among absentees.
    const lastPt = trend[trend.length - 1] as Record<string, unknown> | undefined;
    const present = (t: string) => typeof lastPt?.[t] === 'number';
    const types = [...latestByType.keys()].sort((a, b) => {
      const pa = present(a) ? 1 : 0;
      const pb = present(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const va = pa ? (lastPt![a] as number) : latestByType.get(a) ?? 0;
      const vb = pb ? (lastPt![b] as number) : latestByType.get(b) ?? 0;
      return vb - va;
    });
    return Response.json({ trend, types });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
