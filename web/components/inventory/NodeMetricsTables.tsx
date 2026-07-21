'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Meter from '@/components/ui/Meter';

// v1-parity live metric tables for the ElastiCache/OpenSearch/MSK inventory pages
// (owner request 2026-07-21: "V1처럼 노드/도메인/브로커 메트릭 포함").
// All three fetch a bulk fleet endpoint once per page load (Period 300, last-1h latest value)
// and render a plain table under the inventory list. Missing metrics render as '—' — the
// tables never fail the page (fire-and-forget with an error line).

type Row = Record<string, unknown>;
type Fleet = Record<string, Record<string, number | null>>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dash = <span className="text-ink-300">—</span>;
const gb = (v: number | null) => (v == null ? dash : `${(v / 1024 ** 3).toFixed(2)} GB`);
const mb = (v: number | null) => (v == null ? dash : `${(v / 1024 / 1024).toFixed(1)} MB`);
const kbps = (v: number | null) => (v == null ? dash : `${(v / 1024).toFixed(1)} KB/s`);
const cnt = (v: number | null) => (v == null ? dash : Math.round(v).toLocaleString());
const ms = (v: number | null) => (v == null ? dash : `${v.toFixed(1)} ms`);
const meter = (v: number | null) => (v == null ? dash : <Meter value={v} />);

const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400 whitespace-nowrap';
const TD = 'px-3 py-1.5 text-[12px] text-ink-600 whitespace-nowrap';
const MONO = `${TD} font-mono text-[11.5px]`;

function useFleet(type: string, ids: string[]): { fleet: Fleet; err: string } {
  const [fleet, setFleet] = useState<Fleet>({});
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/${type}/metrics?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [type, key]);
  return { fleet, err };
}

// ── ElastiCache: per-node rows (cache_nodes JSONB flattened; metrics are cluster-level, v1 parity) ──
interface CacheNode { CacheNodeId?: string; cache_node_id?: string; CacheNodeStatus?: string; cache_node_status?: string; CustomerAvailabilityZone?: string; customer_availability_zone?: string; Endpoint?: { Address?: string }; endpoint?: { address?: string } }

export function ElasticacheNodeMetrics({ rows }: { rows: Row[] }) {
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('elasticache', ids);
  if (rows.length === 0) return null;

  const nodeRows = rows.flatMap((r) => {
    const raw = r.cache_nodes;
    const nodes: CacheNode[] = Array.isArray(raw) && raw.length > 0 ? (raw as CacheNode[]) : [{}];
    return nodes.map((n) => ({ cluster: r, node: n }));
  });

  return (
    <Card title="노드 메트릭 (Last 1h)" subtitle={`${nodeRows.length} nodes · CloudWatch AWS/ElastiCache (클러스터 단위)`} padded={false}>
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">메트릭 조회 실패: {err}</div>}
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
    </Card>
  );
}

// ── OpenSearch: per-domain metric rows (v1 도메인 메트릭) ──
export function OpensearchDomainMetrics({ rows }: { rows: Row[] }) {
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('opensearch', ids);
  if (rows.length === 0) return null;

  return (
    <Card title="도메인 메트릭 (Last 1h)" subtitle={`${ids.length} domains · CloudWatch AWS/ES`} padded={false}>
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">메트릭 조회 실패: {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Domain', 'Engine', 'Cluster Status', 'CPU', 'JVM Memory', 'Nodes', 'Documents', 'Free Storage', 'Search Rate', 'Search Latency', 'Index Rate', 'Index Latency'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const m = fleet[String(r.resource_id)] ?? {};
              const status = (num(m.red) ?? 0) >= 1 ? 'RED' : (num(m.yellow) ?? 0) >= 1 ? 'YELLOW' : (num(m.green) ?? 0) >= 1 ? 'GREEN' : null;
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(r.resource_id)}</td>
                  <td className={TD}>{String(r.engine_type ?? '—')} {String(r.engine_version ?? '')}</td>
                  <td className={TD}>
                    {status ? (
                      <Badge tone={status === 'GREEN' ? 'positive' : status === 'YELLOW' ? 'brand' : 'negative'} variant="soft" dot>{status}</Badge>
                    ) : dash}
                  </td>
                  <td className={TD}>{meter(num(m.cpu))}</td>
                  <td className={TD}>{meter(num(m.jvm))}</td>
                  <td className={TD}>{cnt(num(m.nodes))}</td>
                  <td className={TD}>{cnt(num(m.docs))}</td>
                  <td className={TD}>{num(m.freeStorage) == null ? dash : `${((num(m.freeStorage) as number) / 1024).toFixed(1)} GB`}</td>
                  <td className={TD}>{num(m.searchRate) == null ? dash : `${(num(m.searchRate) as number).toFixed(1)}/5m`}</td>
                  <td className={TD}>{ms(num(m.searchLatency))}</td>
                  <td className={TD}>{num(m.indexRate) == null ? dash : `${(num(m.indexRate) as number).toFixed(1)}/5m`}</td>
                  <td className={TD}>{ms(num(m.indexLatency))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── MSK: broker/controller node rows (kafka ListNodes + per-broker CloudWatch) ──
interface MskNodeRow { nodeType: string; brokerId: number | null; instanceType: string | null; clientVpcIp: string | null; eni: string | null; endpoints: string[] }

export function MskBrokerNodes({ rows }: { rows: Row[] }) {
  const [data, setData] = useState<Record<string, { nodes: MskNodeRow[]; brokerMetrics: Fleet }>>({});
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const clusters = useMemo(
    () => rows
      .map((r) => ({ name: String(r.resource_id), arn: typeof r.arn === 'string' ? r.arn : '' }))
      .filter((c) => c.arn),
    [rows],
  );
  const key = clusters.map((c) => c.arn).join(',');

  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(clusters.map((c) =>
      fetch(`/api/inventory/msk/metrics?nodes=${encodeURIComponent(c.arn)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => [c.name, d] as const),
    ))
      .then((pairs) => { if (live) { setData(Object.fromEntries(pairs)); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (clusters.length === 0) return null;
  const flat = clusters.flatMap((c) => (data[c.name]?.nodes ?? []).map((n) => ({ cluster: c.name, n })));
  const brokers = flat.filter((x) => x.n.nodeType === 'BROKER');
  const controllers = flat.filter((x) => x.n.nodeType !== 'BROKER');

  return (
    <Card
      title="Broker Nodes"
      subtitle={`${brokers.length} brokers · ${controllers.length} controllers · CloudWatch AWS/Kafka (브로커 단위, Last 1h)`}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">노드 조회 실패: {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Cluster', 'Type', 'ID', 'Instance', 'VPC IP', 'ENI', 'CPU', 'Memory', 'Net In', 'Net Out', 'Endpoint'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {brokers.map(({ cluster, n }, i) => {
              const m = data[cluster]?.brokerMetrics?.[String(n.brokerId)] ?? {};
              const cpuUser = num(m.cpuUser); const cpuSystem = num(m.cpuSystem);
              const cpu = cpuUser == null && cpuSystem == null ? null : (cpuUser ?? 0) + (cpuSystem ?? 0);
              const used = num(m.memUsed); const free = num(m.memFree);
              const memPct = used != null && free != null && used + free > 0 ? (used / (used + free)) * 100 : null;
              return (
                <tr key={`b${i}`} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{cluster}</td>
                  <td className={TD}><Badge tone="brand" variant="soft">BROKER</Badge></td>
                  <td className={TD}>{n.brokerId ?? '—'}</td>
                  <td className={MONO}>{n.instanceType ?? '—'}</td>
                  <td className={MONO}>{n.clientVpcIp ?? '—'}</td>
                  <td className={MONO}>{n.eni ?? '—'}</td>
                  <td className={TD}>{meter(cpu)}</td>
                  <td className={TD}>{meter(memPct)}</td>
                  <td className={TD}>{kbps(num(m.bytesIn))}</td>
                  <td className={TD}>{kbps(num(m.bytesOut))}</td>
                  <td className={MONO}>{n.endpoints[0] ?? '—'}</td>
                </tr>
              );
            })}
            {controllers.map(({ cluster, n }, i) => (
              <tr key={`c${i}`} className="border-b border-ink-50 last:border-0">
                <td className={MONO}>{cluster}</td>
                <td className={TD}><Badge tone="neutral" variant="soft">CTRL</Badge></td>
                <td className={TD}>—</td>
                <td className={TD}>KRaft</td>
                <td className={TD} colSpan={5}><span className="text-ink-300">—</span></td>
                <td className={MONO}>{n.endpoints[0] ?? '—'}</td>
              </tr>
            ))}
            {flat.length === 0 && !err && (
              <tr><td className={TD} colSpan={11}>
                <span className="text-ink-400">{loaded ? '브로커 노드 없음 — kafka:ListNodes 권한 또는 클러스터 상태를 확인하세요' : '노드 조회 중…'}</span>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
