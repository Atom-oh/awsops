import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { ec2AvgCpu, ec2HourlyCost, rdsMetrics } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

type Card = { label: string; value: string | number; accent?: boolean };

// Supplementary KPI cards (CloudWatch avg CPU + Pricing hourly cost). EC2-first.
// Every failure path degrades silently to { cards: [] } — these cards never blank
// the page (the F3 total/state tiles + donut + table + F4 detail panel stay intact).
export async function GET(request: Request, { params }: { params: { type: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    if (params.type === 'ec2') {
      const r = await getPool().query<{ id: string | null; state: string | null; type: string | null }>(
        `SELECT data->>'instance_id' AS id, data->>'instance_state' AS state, data->>'instance_type' AS type
         FROM inventory_resources WHERE resource_type = 'ec2' AND account_id = 'self'`,
      );
      const runningIds = r.rows
        .filter((x) => x.state === 'running')
        .map((x) => x.id)
        .filter((id): id is string => !!id);
      const typeCounts: Record<string, number> = {};
      for (const x of r.rows) {
        if (x.type) typeCounts[x.type] = (typeCounts[x.type] ?? 0) + 1;
      }

      const [cpu, cost] = await Promise.all([ec2AvgCpu(runningIds), ec2HourlyCost(typeCounts)]);
      const cards: Card[] = [
        { label: '평균 CPU', value: cpu == null ? '—' : `${cpu}%`, accent: true },
        { label: '시간당 비용(USD)', value: cost == null ? '—' : `$${cost.toFixed(2)}`, accent: true },
      ];
      return Response.json({ cards });
    }

    if (params.type === 'rds') {
      // resource_id = DBInstanceIdentifier (sync_lambda). Metrics are a live CloudWatch read (not stored).
      const r = await getPool().query<{ id: string | null }>(
        `SELECT resource_id AS id FROM inventory_resources WHERE resource_type = 'rds' AND account_id = 'self'`,
      );
      const ids = r.rows.map((x) => x.id).filter((id): id is string => !!id);
      const m = await rdsMetrics(ids);
      const vals = Object.values(m.byInstance);
      const conns = vals.map((x) => x.connections).filter((v): v is number => v != null);
      const totalConns = conns.length ? conns.reduce((a, b) => a + b, 0) : null;
      const stores = vals.map((x) => x.freeStorage).filter((v): v is number => v != null);
      const minStoreGb = stores.length ? Math.round((Math.min(...stores) / 1e9) * 10) / 10 : null;
      const cards: Card[] = [
        { label: '평균 CPU', value: m.avgCpu == null ? '—' : `${m.avgCpu}%`, accent: true },
        { label: '총 DB 커넥션', value: totalConns == null ? '—' : totalConns },
        { label: '최소 여유 스토리지', value: minStoreGb == null ? '—' : `${minStoreGb}GB` },
      ];
      return Response.json({ cards });
    }

    return Response.json({ cards: [] });
  } catch {
    return Response.json({ cards: [] });
  }
}
