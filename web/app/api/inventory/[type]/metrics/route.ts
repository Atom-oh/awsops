import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { ec2AvgCpu, ec2HourlyCost, rdsMetrics, hasLiveMetrics, liveResourceMetrics, mskBootstrapBrokers, elasticacheFleetLive, opensearchFleetLive, mskListNodes, mskBrokerFleetLive, mskClusterHealth, mskOffsetLags, rdsFleetLive } from '@/lib/metrics';
import { regionWhereClause, type RegionScope } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

type Card = { label: string; value: string | number; accent?: boolean };

// Supplementary KPI cards (CloudWatch avg CPU + Pricing hourly cost). EC2-first.
// Every failure path degrades silently to { cards: [] } — these cards never blank
// the page (the F3 total/state tiles + donut + table + F4 detail panel stay intact).
// KNOWN LIMITATION (pre-existing, not introduced or fixed by the region-scope filter): the
// instance IDs fed to ec2AvgCpu/ec2HourlyCost/rdsMetrics below are now correctly scoped by
// region, but lib/metrics.ts itself queries CloudWatch/Pricing against a single fixed
// AWS_REGION client — it has no per-instance region routing. Selecting a non-default region
// narrows the table correctly but these two KPI cards can go null/inaccurate for it. Fixing
// that needs per-region CloudWatch clients in lib/metrics.ts, which is a separate change.
export async function GET(request: Request, { params }: { params: { type: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const regionsParam = url.searchParams.get('regions');
  const regions: RegionScope = regionsParam === null || regionsParam === '__all__' ? '__all__' : regionsParam.split(',').filter(Boolean);
  const includeGlobal = url.searchParams.get('includeGlobal') !== '0';
  try {
    if (params.type === 'ec2') {
      const qparams: unknown[] = [];
      const where = `resource_type = 'ec2' AND account_id = 'self'` + regionWhereClause(regions, includeGlobal, qparams);
      const r = await getPool().query<{ id: string | null; state: string | null; type: string | null }>(
        `SELECT data->>'instance_id' AS id, data->>'instance_state' AS state, data->>'instance_type' AS type
         FROM inventory_resources WHERE ${where}`,
        qparams,
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
      // ?ids=a,b → per-instance diagnostic fleet (page table); ?id=<x> → detail-panel series; else KPI cards.
      const idsParam = new URL(request.url).searchParams.get('ids');
      if (idsParam !== null) {
        const ids = idsParam.split(',').map((x) => x.trim()).filter((x) => /^[a-zA-Z0-9.-]+$/.test(x)).slice(0, 200);
        return Response.json({ fleet: await rdsFleetLive(ids) });
      }
      const instanceId = new URL(request.url).searchParams.get('id');
      if (instanceId) {
        const one = await rdsMetrics([instanceId]);
        return Response.json({ instance: one.byInstance[instanceId] ?? null });
      }
      const qparams: unknown[] = [];
      const where = `resource_type = 'rds' AND account_id = 'self'` + regionWhereClause(regions, includeGlobal, qparams);
      const r = await getPool().query<{ id: string | null }>(
        `SELECT resource_id AS id FROM inventory_resources WHERE ${where}`,
        qparams,
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

    // v1-parity fleet metrics (page-level tables):
    // elasticache/opensearch ?ids=a,b → { fleet: { id: {metricKey: value|null} } }
    if ((params.type === 'elasticache' || params.type === 'opensearch') && url.searchParams.get('ids') !== null) {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',').map((x) => x.trim()).filter((x) => /^[a-zA-Z0-9._-]+$/.test(x)).slice(0, 200);
      const fleet = params.type === 'elasticache' ? await elasticacheFleetLive(ids) : await opensearchFleetLive(ids);
      return Response.json({ fleet });
    }
    // msk ?nodes=<clusterArn> → { nodes, brokerMetrics } (kafka ListNodes + per-broker CloudWatch)
    if (params.type === 'msk' && url.searchParams.get('nodes') !== null) {
      const arn = url.searchParams.get('nodes') ?? '';
      if (!/^arn:aws:kafka:[a-z0-9-]+:\d{12}:cluster\/[a-zA-Z0-9._-]+\/[a-z0-9-]+$/.test(arn)) {
        return Response.json({ status: 'error', message: 'invalid cluster arn' }, { status: 400 });
      }
      const clusterName = arn.split('/')[1];
      const clusterRegion = arn.split(':')[3];
      const nodes = await mskListNodes(arn);
      const brokerIds = nodes.filter((n) => n.nodeType === 'BROKER' && n.brokerId != null).map((n) => n.brokerId as number);
      const [brokerMetrics, health, lags] = await Promise.all([
        brokerIds.length ? mskBrokerFleetLive(clusterName, brokerIds, clusterRegion) : Promise.resolve({}),
        mskClusterHealth(clusterName, clusterRegion),
        mskOffsetLags(clusterName, clusterRegion),
      ]);
      return Response.json({ nodes, brokerMetrics, health, lags });
    }

    // ElastiCache/OpenSearch/MSK: per-resource live metrics for the detail panel (?id=).
    if (hasLiveMetrics(params.type)) {
      const id = url.searchParams.get('id');
      if (id) {
        const metrics = await liveResourceMetrics(params.type, id);
        // MSK: append bootstrap broker connection strings (v1 parity) — ARN from the synced row.
        if (params.type === 'msk') {
          try {
            const r = await getPool().query<{ arn: string | null }>(
              `SELECT data->>'arn' AS arn FROM inventory_resources
               WHERE resource_type='msk' AND resource_id=$1 LIMIT 1`,
              [id],
            );
            const arn = r.rows[0]?.arn;
            if (arn) metrics.push(...(await mskBootstrapBrokers(arn)));
          } catch { /* bootstrap rows omitted */ }
        }
        return Response.json({ metrics });
      }
    }

    return Response.json({ cards: [] });
  } catch {
    return Response.json({ cards: [] });
  }
}
