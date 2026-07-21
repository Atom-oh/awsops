'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
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
interface MskLagRow { consumerGroup: string; topic: string; maxOffsetLag: number | null }
interface MskClusterData { nodes: MskNodeRow[]; brokerMetrics: Fleet; health?: Record<string, number | null>; lags?: MskLagRow[] }

// 진단 우선순위 (owner 가이드): 정상 기대값과 비교해 ok/위험을 색으로 표시.
function HealthPill({ label, value, ok, hint }: { label: string; value: string; ok: boolean | null; hint: string }) {
  return (
    <span
      title={hint}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
        ok == null ? 'border-ink-100 text-ink-400' : ok ? 'border-emerald-200 bg-emerald-500/5 text-emerald-700' : 'border-rose-300 bg-rose-500/10 text-rose-700 font-semibold'
      }`}
    >
      <span className="text-ink-400">{label}</span>
      <span className="tabular">{value}</span>
    </span>
  );
}

// MSK 진단 가이드 — 접이식 (owner: "설명 내용을 화면에서 펼쳐 보기로"). 모니터링 레벨 + 계층별
// 지표 설명 + 경보 우선순위 표. 정적 콘텐츠라 데이터 fetch 없음.
function MskDiagnosisGuide() {
  const [open, setOpen] = useState(false);
  const th = 'px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400';
  const td = 'px-2.5 py-1.5 text-[12px] text-ink-600';
  const h4 = 'mt-3 mb-1 text-[12.5px] font-semibold text-ink-700';
  return (
    <div className="border-t border-ink-100">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12.5px] font-medium text-brand-700 hover:bg-ink-50"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        MSK 진단 가이드 — 지표 읽는 법 (펼쳐 보기)
      </button>
      {open && (
        <div className="px-5 pb-4 text-[12.5px] leading-relaxed text-ink-600">
          <p className="mt-1">
            MSK는 <b>모니터링 레벨</b>(DEFAULT / PER_BROKER / PER_TOPIC_PER_BROKER / PER_TOPIC_PER_PARTITION)에 따라
            노출되는 메트릭이 달라집니다. 진단이 필요하면 최소 <b>PER_BROKER 이상</b>으로 올려두는 것을 권장합니다.
          </p>

          <div className={h4}>① 브로커 리소스 (병목의 근원)</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>CpuUser + CpuSystem</b> — 합산 60~70% 초과 시 경보. MSK 권장: CPU 여유 40% 이상 유지.</li>
            <li><b>KafkaDataLogsDiskUsed</b> — 데이터 디스크 사용률(%). <b>가장 흔한 장애 원인</b> — 85% 초과 시 위험, 스토리지 확장/오토스케일링 필요.</li>
            <li><b>MemoryUsed / MemoryFree</b>, <b>RootDiskUsed</b> — 루트 볼륨도 함께 확인.</li>
          </ul>

          <div className={h4}>② 클러스터 건강성</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>ActiveControllerCount</b> — 정상값은 정확히 <b>1</b>. 0이거나 2 이상이면 컨트롤러 이상 → 즉시 조사.</li>
            <li><b>OfflinePartitionsCount</b> — 정상값 <b>0</b>. 0보다 크면 해당 파티션 서비스 불가 (데이터 가용성 문제).</li>
            <li><b>UnderReplicatedPartitions</b> — 정상값 <b>0</b>. 0보다 크면 복제가 뒤처지는 중 (브로커 부하/장애 신호).</li>
            <li><b>UnderMinIsrPartitionCount</b> — min.insync.replicas 미달 파티션. acks=all 프로듀서가 쓰기 거부당하는 상황.</li>
          </ul>

          <div className={h4}>③ 처리량·트래픽</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>BytesInPerSec / BytesOutPerSec</b> — 인스턴스 타입의 네트워크 한계 대비 확인. <b>MessagesInPerSec</b> 병행.</li>
            <li><b>ProduceThrottleTime / FetchThrottleTime</b> — 쿼터/네트워크 스로틀링 발생 여부.</li>
          </ul>

          <div className={h4}>④ 지연(Latency)</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>RequestQueueSize / ResponseQueueSize</b> — 큐가 쌓이면 브로커가 요청을 못 따라가는 중.</li>
            <li>Produce/Fetch 레이턴시 (FetchConsumerTotalTimeMsMean 등)로 상세 확인.</li>
          </ul>

          <div className={h4}>⑤ 컨슈머 지연 — 실무에서 가장 중요</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>MaxOffsetLag / SumOffsetLag / EstimatedMaxTimeLag</b> — 컨슈머가 프로듀서를 못 따라가면 lag이 계속 증가. 실시간 파이프라인 진단의 최우선 지표.</li>
            <li>컨슈머 그룹 lag은 CloudWatch 외에 Kafka 자체 <code className="rounded bg-ink-50 px-1 font-mono text-[11px]">kafka-consumer-groups.sh</code>로도 확인.</li>
          </ul>

          <div className={h4}>⑥ 연결</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>ConnectionCount / ClientConnectionCount</b>, <b>ConnectionCreationRate / CloseRate</b> — 커넥션 폭증·재연결 폭풍 감지.</li>
          </ul>

          <div className={h4}>경보 우선순위 요약</div>
          <div className="overflow-x-auto rounded-lg border border-ink-100">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100 bg-paper-muted/60">
                <th className={th}>메트릭</th><th className={th}>정상값</th><th className={th}>의미</th>
              </tr></thead>
              <tbody>
                {[
                  ['ActiveControllerCount', '= 1', '컨트롤러 정상'],
                  ['OfflinePartitionsCount', '= 0', '가용성'],
                  ['UnderReplicatedPartitions', '= 0', '복제 건강성'],
                  ['KafkaDataLogsDiskUsed', '< 85%', '디스크 고갈 방지'],
                  ['CpuUser + CpuSystem', '< ~60%', '부하 여유'],
                  ['MaxOffsetLag', '추세 안정', '컨슈머 처리 지연'],
                ].map(([m, v, d]) => (
                  <tr key={m} className="border-b border-ink-50 last:border-0">
                    <td className={`${td} font-mono text-[11.5px]`}>{m}</td>
                    <td className={`${td} tabular`}>{v}</td>
                    <td className={td}>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function MskBrokerNodes({ rows }: { rows: Row[] }) {
  const [data, setData] = useState<Record<string, MskClusterData>>({});
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
  const allLags = clusters.flatMap((c) => (data[c.name]?.lags ?? []).map((l) => ({ cluster: c.name, ...l })));

  // 클러스터별 건강성 요약: 컨트롤러/오프라인 파티션은 클러스터 레벨, URP·MinISR·디스크·CPU는 브로커 값 집계.
  const healthRows = clusters.map((c) => {
    const d = data[c.name];
    const h = d?.health ?? {};
    const bm = Object.values(d?.brokerMetrics ?? {});
    const sum = (k: string) => bm.reduce<number | null>((acc, m) => (num(m[k]) == null ? acc : (acc ?? 0) + (num(m[k]) as number)), null);
    const max = (k: string) => bm.reduce<number | null>((acc, m) => (num(m[k]) == null ? acc : Math.max(acc ?? 0, num(m[k]) as number)), null);
    const cpuMax = bm.reduce<number | null>((acc, m) => {
      const u = num(m.cpuUser); const sy = num(m.cpuSystem);
      if (u == null && sy == null) return acc;
      return Math.max(acc ?? 0, (u ?? 0) + (sy ?? 0));
    }, null);
    return {
      cluster: c.name,
      controllers: num(h.activeControllers),
      offline: num(h.offlinePartitions),
      urp: sum('urp'),
      minIsr: sum('underMinIsr'),
      dataDiskMax: max('dataDisk'),
      rootDiskMax: max('rootDisk'),
      cpuMax,
    };
  });
  const fmtN = (v: number | null) => (v == null ? '—' : Math.round(v).toLocaleString());
  const fmtPct = (v: number | null) => (v == null ? '—' : `${v.toFixed(0)}%`);

  return (
    <Card
      title="Broker Nodes · 클러스터 건강성"
      subtitle={`${brokers.length} brokers · ${controllers.length} controllers · CloudWatch AWS/Kafka (브로커 단위, Last 1h)`}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">노드 조회 실패: {err}</div>}

      {/* 진단 우선순위 스트립 — 정상 기대값(컨트롤러=1, 오프라인/URP/MinISR=0, 디스크<85%, CPU<60%) 대비 색상 */}
      {loaded && healthRows.length > 0 && (
        <div className="flex flex-col gap-1.5 px-4 py-3">
          {healthRows.map((h) => (
            <div key={h.cluster} className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 w-32 truncate font-mono text-[11.5px] text-ink-500" title={h.cluster}>{h.cluster}</span>
              <HealthPill label="Controller" value={fmtN(h.controllers)} ok={h.controllers == null ? null : h.controllers === 1} hint="ActiveControllerCount — 정상값은 정확히 1. 0 또는 2+ 는 컨트롤러 이상 → 즉시 조사." />
              <HealthPill label="Offline" value={fmtN(h.offline)} ok={h.offline == null ? null : h.offline === 0} hint="OfflinePartitionsCount — 정상값 0. 0보다 크면 해당 파티션 서비스 불가 (가용성 문제)." />
              <HealthPill label="URP" value={fmtN(h.urp)} ok={h.urp == null ? null : h.urp === 0} hint="UnderReplicatedPartitions — 정상값 0. 0보다 크면 복제가 뒤처지는 중 (브로커 부하/장애 신호)." />
              <HealthPill label="MinISR" value={fmtN(h.minIsr)} ok={h.minIsr == null ? null : h.minIsr === 0} hint="UnderMinIsrPartitionCount — min.insync.replicas 미달 파티션. acks=all 쓰기가 거부되는 상황." />
              <HealthPill label="Data Disk" value={fmtPct(h.dataDiskMax)} ok={h.dataDiskMax == null ? null : h.dataDiskMax < 85} hint="KafkaDataLogsDiskUsed(max) — 가장 흔한 장애 원인. 85% 초과 시 위험: 스토리지 확장 필요." />
              <HealthPill label="Root Disk" value={fmtPct(h.rootDiskMax)} ok={h.rootDiskMax == null ? null : h.rootDiskMax < 85} hint="RootDiskUsed(max) — 루트 볼륨 사용률." />
              <HealthPill label="CPU max" value={fmtPct(h.cpuMax)} ok={h.cpuMax == null ? null : h.cpuMax < 60} hint="CpuUser+CpuSystem 브로커 최대값 — 60~70% 초과 시 경보 (여유 40% 이상 권장)." />
            </div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto border-t border-ink-100">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Cluster', 'Type', 'ID', 'Instance', 'VPC IP', 'CPU', 'Memory', 'Data Disk', 'Net In', 'Net Out', 'Msgs/s', 'Throttle', 'Endpoint'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {brokers.map(({ cluster, n }, i) => {
              const m = data[cluster]?.brokerMetrics?.[String(n.brokerId)] ?? {};
              const cpuUser = num(m.cpuUser); const cpuSystem = num(m.cpuSystem);
              const cpu = cpuUser == null && cpuSystem == null ? null : (cpuUser ?? 0) + (cpuSystem ?? 0);
              const used = num(m.memUsed); const free = num(m.memFree);
              const memPct = used != null && free != null && used + free > 0 ? (used / (used + free)) * 100 : null;
              const throttle = Math.max(num(m.produceThrottle) ?? 0, num(m.fetchThrottle) ?? 0);
              return (
                <tr key={`b${i}`} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{cluster}</td>
                  <td className={TD}><Badge tone="brand" variant="soft">BROKER</Badge></td>
                  <td className={TD}>{n.brokerId ?? '—'}</td>
                  <td className={MONO}>{n.instanceType ?? '—'}</td>
                  <td className={MONO}>{n.clientVpcIp ?? '—'}</td>
                  <td className={TD} title="CpuUser + CpuSystem — 60% 초과 시 경보 권장">{meter(cpu)}</td>
                  <td className={TD}>{meter(memPct)}</td>
                  <td className={TD} title="KafkaDataLogsDiskUsed — 85% 초과 위험 (가장 흔한 장애 원인)">{meter(num(m.dataDisk))}</td>
                  <td className={TD}>{kbps(num(m.bytesIn))}</td>
                  <td className={TD}>{kbps(num(m.bytesOut))}</td>
                  <td className={TD}>{cnt(num(m.msgsIn))}</td>
                  <td className={TD} title="ProduceThrottleTime / FetchThrottleTime 중 최대값 (ms)">{throttle > 0 ? `${throttle.toFixed(1)} ms` : dash}</td>
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
                <td className={TD} colSpan={8}><span className="text-ink-300">—</span></td>
                <td className={MONO}>{n.endpoints[0] ?? '—'}</td>
              </tr>
            ))}
            {flat.length === 0 && !err && (
              <tr><td className={TD} colSpan={13}>
                <span className="text-ink-400">{loaded ? '브로커 노드 없음 — kafka:ListNodes 권한 또는 클러스터 상태를 확인하세요' : '노드 조회 중…'}</span>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 컨슈머 그룹 lag — 실무 최우선 지표. 시리즈는 ListMetrics로 발견 (그룹/토픽별). */}
      {allLags.length > 0 && (
        <div className="border-t border-ink-100">
          <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">컨슈머 그룹 Offset Lag (MaxOffsetLag, Last 1h)</div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100">
                {['Cluster', 'Consumer Group', 'Topic', 'Max Offset Lag'].map((h) => <th key={h} className={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {allLags.slice(0, 15).map((l, i) => (
                  <tr key={i} className="border-b border-ink-50 last:border-0">
                    <td className={MONO}>{l.cluster}</td>
                    <td className={MONO}>{l.consumerGroup || '—'}</td>
                    <td className={MONO}>{l.topic || '—'}</td>
                    <td className={`${TD} tabular`} title="lag이 계속 증가하면 컨슈머가 프로듀서를 못 따라가는 중 — 추세가 안정적이어야 정상">
                      {l.maxOffsetLag == null ? dash : Math.round(l.maxOffsetLag).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <MskDiagnosisGuide />
    </Card>
  );
}
