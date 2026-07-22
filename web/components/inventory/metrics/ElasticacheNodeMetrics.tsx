'use client';
import { useMemo } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import DiagnosisGuide from './DiagnosisGuide';
import { EC_GUIDE } from './guides';
import { type Row, num, dash, gb, mb, cnt, meter, TH, TD, MONO, DANGER, useFleet } from './shared';
import { useI18n } from '@/components/shell/LanguageProvider';

// ── ElastiCache: per-node rows (cache_nodes JSONB flattened; metrics are cluster-level, v1 parity) ──
interface CacheNode { CacheNodeId?: string; cache_node_id?: string; CacheNodeStatus?: string; cache_node_status?: string; CustomerAvailabilityZone?: string; customer_availability_zone?: string; Endpoint?: { Address?: string }; endpoint?: { address?: string } }

export function ElasticacheNodeMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('elasticache', ids);
  if (rows.length === 0) return null;

  const nodeRows = rows.flatMap((r) => {
    const raw = r.cache_nodes;
    const nodes: CacheNode[] = Array.isArray(raw) && raw.length > 0 ? (raw as CacheNode[]) : [{}];
    return nodes.map((n) => ({ cluster: r, node: n }));
  });

  return (
    <Card title={tt('노드 메트릭 (Last 1h)')} subtitle={`${nodeRows.length} nodes · CloudWatch AWS/ElastiCache (${tt('클러스터 단위')})`} padded={false}>
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패:')} {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Cluster', 'Engine', 'Version', 'Node Type', 'Node ID', 'Status', 'CPU', 'Engine CPU', 'Memory', 'Net In', 'Net Out', 'Conn', 'AZ', 'Endpoint'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {nodeRows.map(({ cluster, node }, i) => {
              const m = fleet[String(cluster.resource_id)] ?? {};
              const engine = String(cluster.engine ?? '—');
              const status = String(node.CacheNodeStatus ?? node.cache_node_status ?? cluster.cache_cluster_status ?? '—');
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(cluster.resource_id)}</td>
                  <td className={TD}>
                    <Badge tone={engine === 'valkey' ? 'negative' : engine === 'redis' ? 'brand' : 'positive'} variant="soft">{engine}</Badge>
                  </td>
                  <td className={TD}>{String(cluster.engine_version ?? '—')}</td>
                  <td className={MONO}>{String(cluster.cache_node_type ?? '—')}</td>
                  <td className={MONO}>{String(node.CacheNodeId ?? node.cache_node_id ?? '0001')}</td>
                  <td className={TD}><Badge tone={status === 'available' ? 'positive' : 'brand'} variant="soft" dot>{status}</Badge></td>
                  <td className={TD}>{meter(num(m.cpu))}</td>
                  <td className={TD}>{meter(num(m.ecpu))}</td>
                  <td className={TD}>{gb(num(m.mem))}</td>
                  <td className={TD}>{mb(num(m.netIn))}</td>
                  <td className={TD}>{mb(num(m.netOut))}</td>
                  <td className={TD}>{cnt(num(m.conn))}</td>
                  <td className={TD}>{String(node.CustomerAvailabilityZone ?? node.customer_availability_zone ?? cluster.preferred_availability_zone ?? '—')}</td>
                  <td className={MONO}>{String(node.Endpoint?.Address ?? node.endpoint?.address ?? '—')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 진단 지표 (owner 가이드): 메모리 압박·히트율·축출·대역폭 상한·복제 지연 — 클러스터 단위 */}
      <div className="border-t border-ink-100">
        <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">진단 지표 (Redis/Valkey 중심, Last 1h)</div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-ink-100">
              {['Cluster', 'Engine', 'DB Mem', 'Hit Rate', 'Evictions', 'Reclaimed', 'Swap', 'Items', 'New Conn', 'BW 상한 초과', 'Repl Lag'].map((h) => <th key={h} className={TH}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const m = fleet[String(r.resource_id)] ?? {};
                const evict = num(m.evictions);
                const swapMb = num(m.swap) == null ? null : (num(m.swap) as number) / 1024 / 1024;
                // CacheHitRate: 요청이 없으면 null — 값이 0..1 비율로 오면 %로 환산.
                const hrRaw = num(m.hitRate);
                const hitPct = hrRaw == null ? null : hrRaw <= 1 ? hrRaw * 100 : hrRaw;
                const bwEx = (num(m.bwInEx) ?? 0) + (num(m.bwOutEx) ?? 0);
                const replLag = num(m.replLag);
                return (
                  <tr key={i} className="border-b border-ink-50 last:border-0">
                    <td className={MONO}>{String(r.resource_id)}</td>
                    <td className={TD}>{String(r.engine ?? '—')}</td>
                    <td className={TD} title="DatabaseMemoryUsagePercentage — maxmemory 대비 사용률, 가장 중요한 경보 지표">{meter(num(m.dbMemPct))}</td>
                    <td className={`${TD} ${hitPct != null && hitPct < 80 ? DANGER : ''}`} title="CacheHitRate — 낮으면 캐시 효용 저하 (TTL 짧음/키 설계/콜드 캐시)">
                      {hitPct == null ? dash : `${hitPct.toFixed(1)}%`}
                    </td>
                    <td className={`${TD} ${evict != null && evict > 0 ? DANGER : ''}`} title="Evictions(5분 누적) — >0 지속 = 메모리 부족으로 키 강제 축출 → 노드 확장/샤딩/maxmemory-policy 재검토">
                      {cnt(evict)}
                    </td>
                    <td className={TD} title="Reclaimed — TTL 만료로 제거된 키 수 (정상 동작)">{cnt(num(m.reclaimed))}</td>
                    <td className={`${TD} ${swapMb != null && swapMb > 50 ? DANGER : ''}`} title="SwapUsage — 커지면 디스크 스왑 → 지연 급증 위험">
                      {swapMb == null ? dash : `${swapMb.toFixed(0)} MB`}
                    </td>
                    <td className={TD} title="CurrItems — 저장된 아이템 수">{cnt(num(m.currItems))}</td>
                    <td className={TD} title="NewConnections(5분 누적) — 급증 시 커넥션 풀 미사용/재연결 폭풍 의심">{cnt(num(m.newConn))}</td>
                    <td className={`${TD} ${bwEx > 0 ? DANGER : ''}`} title="NetworkBandwidthIn/OutAllowanceExceeded — 인스턴스 네트워크 상한 초과, 놓치기 쉬운 병목">
                      {num(m.bwInEx) == null && num(m.bwOutEx) == null ? dash : Math.round(bwEx).toLocaleString()}
                    </td>
                    <td className={`${TD} ${replLag != null && replLag > 10 ? DANGER : ''}`} title="ReplicationLag(초) — 리드 리플리카 복제 지연, 증가 추세면 경보">
                      {replLag == null ? dash : `${replLag.toFixed(1)}s`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DiagnosisGuide spec={EC_GUIDE} />
    </Card>
  );
}
