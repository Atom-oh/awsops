import { verifyUser } from '@/lib/auth';
import { listClusters, getMtdCost } from '@/lib/aws';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  // jobs counts (Aurora) — required
  const jobs = { queued: 0, running: 0, succeeded: 0, failed: 0 } as Record<string, number>;
  try {
    const r = await getPool().query(`SELECT status, count(*)::int AS n FROM worker_jobs GROUP BY status`);
    for (const row of r.rows) if (row.status in jobs) jobs[row.status] = Number(row.n);
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // clusters + cost — degrade independently (a CE/EKS hiccup shouldn't blank the whole page)
  let clusterCount: number | null = null;
  try { clusterCount = (await listClusters()).length; } catch { clusterCount = null; }
  let mtdCost: number | null = null;
  try { mtdCost = (await getMtdCost()).total; } catch { mtdCost = null; }
  return Response.json({ jobs, clusterCount, mtdCost });
}
