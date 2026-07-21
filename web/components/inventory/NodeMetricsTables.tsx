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
                const danger = 'text-rose-700 font-semibold';
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
                    <td className={`${TD} ${hitPct != null && hitPct < 80 ? danger : ''}`} title="CacheHitRate — 낮으면 캐시 효용 저하 (TTL 짧음/키 설계/콜드 캐시)">
                      {hitPct == null ? dash : `${hitPct.toFixed(1)}%`}
                    </td>
                    <td className={`${TD} ${evict != null && evict > 0 ? danger : ''}`} title="Evictions(5분 누적) — >0 지속 = 메모리 부족으로 키 강제 축출 → 노드 확장/샤딩/maxmemory-policy 재검토">
                      {cnt(evict)}
                    </td>
                    <td className={TD} title="Reclaimed — TTL 만료로 제거된 키 수 (정상 동작)">{cnt(num(m.reclaimed))}</td>
                    <td className={`${TD} ${swapMb != null && swapMb > 50 ? danger : ''}`} title="SwapUsage — 커지면 디스크 스왑 → 지연 급증 위험">
                      {swapMb == null ? dash : `${swapMb.toFixed(0)} MB`}
                    </td>
                    <td className={TD} title="CurrItems — 저장된 아이템 수">{cnt(num(m.currItems))}</td>
                    <td className={TD} title="NewConnections(5분 누적) — 급증 시 커넥션 풀 미사용/재연결 폭풍 의심">{cnt(num(m.newConn))}</td>
                    <td className={`${TD} ${bwEx > 0 ? danger : ''}`} title="NetworkBandwidthIn/OutAllowanceExceeded — 인스턴스 네트워크 상한 초과, 놓치기 쉬운 병목">
                      {num(m.bwInEx) == null && num(m.bwOutEx) == null ? dash : Math.round(bwEx).toLocaleString()}
                    </td>
                    <td className={`${TD} ${replLag != null && replLag > 10 ? danger : ''}`} title="ReplicationLag(초) — 리드 리플리카 복제 지연, 증가 추세면 경보">
                      {replLag == null ? dash : `${replLag.toFixed(1)}s`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <EcDiagnosisGuide />
    </Card>
  );
}

// ElastiCache 진단 가이드 — 접이식 (owner 가이드: 엔진별 차이 + 증상별 진단 경로).
function EcDiagnosisGuide() {
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
        ElastiCache 진단 가이드 — 지표 읽는 법 (펼쳐 보기)
      </button>
      {open && (
        <div className="px-5 pb-4 text-[12.5px] leading-relaxed text-ink-600">
          <p className="mt-1">
            엔진(Redis/Valkey vs Memcached)에 따라 메트릭이 다르지만 공통적으로 <b>CPU · 메모리 · 연결 ·
            성능(히트율/지연) · 엔진 고유 지표</b>를 봅니다. 아래는 Redis/Valkey 기준입니다.
          </p>

          <div className={h4}>① CPU</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>EngineCPUUtilization</b> — Redis/Valkey에서 가장 중요. 주 명령 처리가 사실상 <b>단일 스레드</b>라 코어 하나가 포화되면 CPUUtilization(전체 vCPU 평균)은 낮아 보여도 실제로는 병목.</li>
            <li><b>CPUUtilization</b> — 노드 전체. <b>Memcached는 멀티스레드라 이쪽이 유효.</b></li>
            <li>EngineCPU 지속 높음 → 느린 명령(O(N): KEYS, 큰 HGETALL, 대형 SORT) 의심 또는 샤드 확장.</li>
          </ul>

          <div className={h4}>② 메모리 — 진단 핵심</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>DatabaseMemoryUsagePercentage</b> — maxmemory 대비 사용률. <b>가장 중요한 경보 지표.</b> FreeableMemory / BytesUsedForCache 병행.</li>
            <li><b>SwapUsage</b> — 커지면 위험(디스크 스왑 → 지연 급증).</li>
            <li><b>Evictions</b> — 메모리가 꽉 차 키 강제 축출. 지속 발생 시 노드 확장·샤딩·maxmemory-policy 재검토. <b>Reclaimed</b>(TTL 만료 제거)는 정상 동작.</li>
          </ul>

          <div className={h4}>③ 성능 — 히트율과 지연</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>CacheHitRate</b>(또는 CacheHits/CacheMisses) — 캐시 효용의 핵심. 낮으면 TTL 너무 짧음 / 캐시 키 설계 문제 / 콜드 캐시.</li>
            <li>명령군별 지연(StringBasedCmdsLatency, GetType/SetType/HashBasedCmdsLatency…)으로 어떤 명령이 느린지 분해. SuccessfulRead/WriteRequestLatency 병행.</li>
          </ul>

          <div className={h4}>④ 연결</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>CurrConnections</b> — maxclients 대비. <b>NewConnections</b> 급증 = 커넥션 풀 미사용/재연결 폭풍 의심(연결 수립 비용 큼). <b>CurrItems</b>는 아이템 수.</li>
          </ul>

          <div className={h4}>⑤ 네트워크·처리량</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>NetworkBytesIn/Out, <b>NetworkBandwidthIn/OutAllowanceExceeded</b> — 인스턴스 타입별 네트워크 상한 초과. <b>놓치기 쉬운 병목.</b> ConnTrack/PPS AllowanceExceeded도 동류.</li>
            <li><b>ReplicationBytes / ReplicationLag</b> — 리드 리플리카 복제 지연.</li>
          </ul>

          <div className={h4}>⑥ 엔진 고유 (Redis/Valkey)</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>KeyspaceHits/Misses, SaveInProgress, BytesUsedForCache. 느린 명령 추적은 Redis <code className="rounded bg-ink-50 px-1 font-mono text-[11px]">SLOWLOG</code> 병행.</li>
            <li>클러스터 모드면 샤드/노드별로 분해해 <b>핫 샤드</b> 확인.</li>
          </ul>

          <div className={h4}>증상별 진단 경로</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>지연 증가 + 전체 CPU 낮음 → <b>EngineCPUUtilization + SLOWLOG</b> 확인.</li>
            <li>간헐적 성능 저하 + Evictions → <b>메모리 부족 / TTL·eviction 정책</b> 재검토.</li>
            <li>원인 불명 지연 + 트래픽 많음 → <b>Network...AllowanceExceeded</b> 대역폭 상한 확인.</li>
            <li>히트율 낮음 → <b>캐시 키 설계·TTL</b> 재검토.</li>
          </ul>

          <div className={h4}>경보 우선순위 요약</div>
          <div className="overflow-x-auto rounded-lg border border-ink-100">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100 bg-paper-muted/60">
                <th className={th}>메트릭</th><th className={th}>주의 기준</th><th className={th}>의미</th>
              </tr></thead>
              <tbody>
                {[
                  ['EngineCPUUtilization', '> 90% (Redis)', '단일 스레드 포화/느린 명령'],
                  ['DatabaseMemoryUsagePercentage', '높음', '메모리 압박'],
                  ['Evictions', '> 0 지속', '메모리 부족 → 키 축출'],
                  ['SwapUsage', '증가', '성능 급락 위험'],
                  ['CacheHitRate', '낮음', '캐시 효용 저하'],
                  ['CurrConnections', 'max 근접', '연결 고갈'],
                  ['Network...AllowanceExceeded', '> 0', '네트워크 상한 병목'],
                  ['ReplicationLag', '증가 추세', '복제 지연'],
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

// ── RDS: per-instance diagnostic table (owner 가이드: CloudWatch/복제/EM/PI 4층위) ──
// 임계값: CPU>80 지속=컴퓨트 병목, Free Storage 고갈=가장 흔한 장애 원인, Swap 증가=메모리 부족,
// 크레딧(BurstBalance/CPUCreditBalance) 0 근접=gp2/T계열 함정, ReplicaLag 증가=복제 지연.

function RdsDiagnosisGuide() {
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
        RDS 진단 가이드 — 지표 읽는 법 (펼쳐 보기)
      </button>
      {open && (
        <div className="px-5 pb-4 text-[12.5px] leading-relaxed text-ink-600">
          <p className="mt-1">
            RDS 진단은 <b>CloudWatch 기본 메트릭 · Enhanced Monitoring · Performance Insights</b> 세 층위를
            함께 봅니다 — 각각 인스턴스 / OS / 쿼리 관점입니다.
          </p>

          <div className={h4}>① CloudWatch 기본 메트릭 (인스턴스 레벨)</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>CPUUtilization</b> — 지속 80% 초과 시 인스턴스 확장 또는 쿼리 튜닝.</li>
            <li><b>CPUCreditBalance / CPUCreditUsage</b> — T계열(버스터블) 한정. 크레딧이 0에 수렴하면 성능 급락. <b>프로덕션에서 자주 놓치는 함정.</b></li>
            <li><b>FreeableMemory</b> — 지속적으로 낮으면 스왑 위험. <b>SwapUsage</b>는 0에 가까워야 정상 — 커지면 성능 급락 신호.</li>
            <li><b>FreeStorageSpace</b> — <b>가장 흔한 장애 원인.</b> 고갈되면 DB가 멈춤 → 스토리지 오토스케일링/경보 필수. <b>DiskQueueDepth</b>가 높으면 스토리지 병목.</li>
            <li><b>ReadIOPS / WriteIOPS</b> — 프로비저닝 IOPS(gp3/io1/io2) 한계 대비. <b>ReadLatency / WriteLatency</b> 급증 = 스토리지 병목. <b>BurstBalance</b>(gp2)는 고갈 시 baseline IOPS로 강등.</li>
            <li><b>DatabaseConnections</b> — max_connections 대비. 커넥션 고갈/누수(풀 미사용) 진단.</li>
          </ul>

          <div className={h4}>② 복제 / 고가용성</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>ReplicaLag</b>(리드 리플리카, 초) / <b>AuroraReplicaLag</b> — 읽기 분산 시 데이터 최신성 문제.</li>
            <li>Multi-AZ 페일오버 이벤트는 RDS Events로 추적.</li>
          </ul>

          <div className={h4}>③ Enhanced Monitoring (OS 레벨, 최소 1초 간격)</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>CloudWatch 기본은 하이퍼바이저 관점 — OS 내부는 Enhanced Monitoring으로: 프로세스별 CPU/메모리, os.cpuUtilization 세부(user/system/wait/idle), os.diskIO, loadAverage.</li>
            <li><b>CPU wait 높음 = I/O 병목, system 높음 = 커널 오버헤드</b> — 원인 구분에 유용.</li>
          </ul>

          <div className={h4}>④ Performance Insights (쿼리 레벨 — 진단의 핵심)</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>DB Load (AAS)</b> — 핵심 지표. <b>Max vCPU 라인 위</b>로 올라가면 과부하.</li>
            <li><b>Wait events 분해</b> — CPU / IO / Lock 중 무엇이 병목인지 (io/table/sql/handler, 락 대기 등).</li>
            <li><b>Top SQL</b> — 부하 유발 상위 쿼리 식별 → 튜닝 대상.</li>
          </ul>

          <div className={h4}>경보 우선순위 요약</div>
          <div className="overflow-x-auto rounded-lg border border-ink-100">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100 bg-paper-muted/60">
                <th className={th}>메트릭</th><th className={th}>주의 기준</th><th className={th}>의미</th>
              </tr></thead>
              <tbody>
                {[
                  ['CPUUtilization', '> 80% 지속', '컴퓨트 병목'],
                  ['FreeStorageSpace', '임계치 이하', '디스크 고갈 → DB 정지'],
                  ['FreeableMemory', '낮음 + SwapUsage 증가', '메모리 부족'],
                  ['DatabaseConnections', 'max 근접', '커넥션 고갈/누수'],
                  ['ReadLatency/WriteLatency', '급증', '스토리지 병목'],
                  ['ReplicaLag', '증가 추세', '복제 지연'],
                  ['BurstBalance/CPUCreditBalance', '0 근접', 'gp2/T계열 크레딧 고갈'],
                  ['DB Load (PI)', '> Max vCPU', '전반 과부하'],
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

export function RdsInstanceMetrics({ rows }: { rows: Row[] }) {
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('rds', ids);
  if (rows.length === 0) return null;

  const lat = (v: number | null) => (v == null ? dash : `${(v * 1000).toFixed(1)} ms`); // CloudWatch RDS latency unit = seconds
  const danger = 'text-rose-700 font-semibold';

  return (
    <Card title="인스턴스 진단 메트릭 (Last 1h)" subtitle={`${ids.length} instances · CloudWatch AWS/RDS (인스턴스 레벨)`} padded={false}>
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">메트릭 조회 실패: {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Instance', 'Engine', 'Class', 'CPU', 'Free Storage', 'Free Mem', 'Swap', 'Conn', 'Read Lat', 'Write Lat', 'IOPS R/W', 'Queue', 'Credit', 'Replica Lag'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const m = fleet[String(r.resource_id)] ?? {};
              const allocGb = Number(r.allocated_storage) || null;
              const freeB = num(m.freeStorage);
              const freePct = allocGb && freeB != null ? (freeB / (allocGb * 1024 ** 3)) * 100 : null;
              const swapMb = num(m.swap) == null ? null : (num(m.swap) as number) / 1024 / 1024;
              // 크레딧: gp2=BurstBalance(%), T계열=CPUCreditBalance — 있는 쪽 표시, 0 근접 시 위험.
              const burst = num(m.burst); const credit = num(m.cpuCredit);
              const replicaLag = num(m.replicaLag);
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(r.resource_id)}</td>
                  <td className={TD}>{String(r.engine ?? '—')}</td>
                  <td className={MONO}>{String(r.class ?? r.db_instance_class ?? '—')}</td>
                  <td className={TD} title="CPUUtilization — 지속 80% 초과 시 확장/쿼리 튜닝">{meter(num(m.cpu))}</td>
                  <td className={`${TD} ${freePct != null && freePct < 15 ? danger : ''}`} title="FreeStorageSpace — 가장 흔한 장애 원인. 고갈되면 DB 정지">
                    {freeB == null ? dash : `${(freeB / 1024 ** 3).toFixed(1)} GB${freePct != null ? ` (${freePct.toFixed(0)}%)` : ''}`}
                  </td>
                  <td className={TD}>{gb(num(m.freeMem))}</td>
                  <td className={`${TD} ${swapMb != null && swapMb > 100 ? danger : ''}`} title="SwapUsage — 0에 가까워야 정상. 커지면 메모리 부족 → 성능 급락">
                    {swapMb == null ? dash : `${swapMb.toFixed(0)} MB`}
                  </td>
                  <td className={TD} title="DatabaseConnections — max_connections 대비 확인">{cnt(num(m.conn))}</td>
                  <td className={TD} title="ReadLatency — 급증 시 스토리지 병목">{lat(num(m.readLat))}</td>
                  <td className={TD} title="WriteLatency — 급증 시 스토리지 병목">{lat(num(m.writeLat))}</td>
                  <td className={TD}>{num(m.readIops) == null && num(m.writeIops) == null ? dash : `${Math.round(num(m.readIops) ?? 0)}/${Math.round(num(m.writeIops) ?? 0)}`}</td>
                  <td className={TD} title="DiskQueueDepth — 높으면 스토리지 병목">{num(m.diskQueue) == null ? dash : (num(m.diskQueue) as number).toFixed(1)}</td>
                  <td className={`${TD} ${(burst != null && burst < 20) || (credit != null && credit < 50) ? danger : ''}`}
                      title="BurstBalance(gp2)/CPUCreditBalance(T계열) — 0 근접 시 성능 강등 (자주 놓치는 함정)">
                    {burst != null ? `${burst.toFixed(0)}%` : credit != null ? Math.round(credit).toLocaleString() : dash}
                  </td>
                  <td className={`${TD} ${replicaLag != null && replicaLag > 10 ? danger : ''}`} title="ReplicaLag(초) — 증가 추세면 복제 지연">
                    {replicaLag == null ? dash : `${replicaLag.toFixed(1)}s`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <RdsDiagnosisGuide />
    </Card>
  );
}

// ── DynamoDB: per-table diagnostic metrics (owner 가이드: 스로틀링·용량·지연·에러·Global Tables) ──

function DdbDiagnosisGuide() {
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
        DynamoDB 진단 가이드 — 지표 읽는 법 (펼쳐 보기)
      </button>
      {open && (
        <div className="px-5 pb-4 text-[12.5px] leading-relaxed text-ink-600">
          <p className="mt-1">
            DynamoDB는 관리형 서비스라 OS/디스크 층위가 없고 <b>CloudWatch 중심으로 처리량·스로틀링·지연·에러</b>를
            봅니다. 캐패시티 모드(On-Demand vs Provisioned)에 따라 관심 지표가 달라집니다.
          </p>

          <div className={h4}>① 스로틀링 — 진단에서 가장 중요</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>ThrottledRequests</b>, <b>ReadThrottleEvents / WriteThrottleEvents</b>, <b>OnlineIndexThrottleEvents</b>(GSI 인덱싱).</li>
            <li>원인은 보통 둘 중 하나: <b>프로비저닝 부족</b>(용량 &lt; 트래픽) 또는 <b>핫 파티션/핫 키</b> — 전체 용량은 남는데 특정 파티션이 한계(파티션당 3000 RCU / 1000 WCU)에 걸림. 후자가 가장 진단하기 까다로운 케이스.</li>
          </ul>

          <div className={h4}>② 캐패시티 사용량</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>ConsumedRead/WriteCapacityUnits</b>(실소비) vs <b>ProvisionedRead/WriteCapacityUnits</b>(설정값)를 겹쳐 여유/부족 판단.</li>
            <li>On-Demand는 소비량 추세 + AccountMaxTableLevelReads/Writes 상한 + 순간 급증(2배 룰 초과) 여부.</li>
          </ul>

          <div className={h4}>③ 지연 (Latency)</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>SuccessfulRequestLatency</b> — <b>오퍼레이션별 분해가 핵심</b>(GetItem/Query/PutItem/Scan…). 서비스 측 지연(네트워크 왕복 제외).</li>
            <li>Scan/Query 지연이 튀면 비효율적 액세스 패턴(풀스캔, 큰 결과셋) 의심.</li>
          </ul>

          <div className={h4}>④ 에러</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>SystemErrors</b>(HTTP 500, 서버 측) / <b>UserErrors</b>(HTTP 400, 클라이언트 측).</li>
            <li><b>ConditionalCheckFailedRequests</b> — 낙관적 락 사용 시 정상적으로도 발생 → 맥락 판단. <b>TransactionConflict</b> 높으면 경합 심함.</li>
          </ul>

          <div className={h4}>⑤ Global Tables / 스트림</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>ReplicationLatency</b>, PendingReplicationCount, AgeOfOldestUnreplicatedRecord — 리전 간 복제 지연.</li>
            <li>Streams를 Lambda로 소비 중이면 Lambda의 <b>IteratorAge</b>로 스트림 처리 지연 확인.</li>
          </ul>

          <div className={h4}>진단 심화: CloudWatch Contributor Insights for DynamoDB</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><b>핫 파티션/핫 키 탐지 특화 도구</b> — 가장 자주 접근되는 파티션 키를 순위로 표시해, 스로틀 원인이 "용량 부족"인지 "키 분포 불균형"인지 구분할 때 결정적.</li>
            <li>Throttled key(스로틀된 키)도 별도 룰로 확인 가능 — 테이블별로 Contributor Insights를 활성화해 사용.</li>
          </ul>

          <div className={h4}>경보 우선순위 요약</div>
          <div className="overflow-x-auto rounded-lg border border-ink-100">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100 bg-paper-muted/60">
                <th className={th}>메트릭</th><th className={th}>주의 기준</th><th className={th}>의미</th>
              </tr></thead>
              <tbody>
                {[
                  ['ReadThrottleEvents / WriteThrottleEvents', '> 0 지속', '용량 부족 또는 핫 파티션'],
                  ['SystemErrors', '급증', '서버 측 이상'],
                  ['ConsumedRCU/WCU vs Provisioned', '근접/초과', '용량 여유 부족'],
                  ['SuccessfulRequestLatency', '급증', '액세스 패턴/성능 문제'],
                  ['ConditionalCheckFailedRequests', '예상보다 높음', '경합 또는 로직 문제'],
                  ['ReplicationLatency (Global Tables)', '증가 추세', '리전 간 복제 지연'],
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

interface DdbReplicationRow { table: string; region: string; latencyMs: number | null }

export function DynamoTableMetrics({ rows }: { rows: Row[] }) {
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [replication, setReplication] = useState<DdbReplicationRow[]>([]);
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/dynamodb/metrics?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setReplication(d.replication ?? []); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key]);
  if (rows.length === 0) return null;

  const danger = 'text-rose-700 font-semibold';
  const lat = (v: number | null) => (v == null ? dash : `${v.toFixed(1)}`); // SuccessfulRequestLatency is already ms
  // 소비 용량: Sum(5분) → 초당 소비율. Provisioned와 직접 비교 (근접/초과 = 위험).
  const rate = (sum: number | null) => (sum == null ? null : sum / 300);
  const capCell = (consumed: number | null, prov: number | null) => {
    const c = rate(consumed);
    if (c == null && prov == null) return dash;
    const provisioned = prov != null && prov > 0 ? prov : null;
    const hot = provisioned != null && c != null && c >= provisioned * 0.8;
    return (
      <span className={hot ? danger : undefined}>
        {c == null ? '0' : c < 10 ? c.toFixed(2) : Math.round(c).toLocaleString()}
        {provisioned != null ? ` / ${Math.round(provisioned).toLocaleString()}` : ''}
      </span>
    );
  };

  return (
    <Card title="테이블 진단 메트릭 (Last 1h)" subtitle={`${ids.length} tables · CloudWatch AWS/DynamoDB · 용량은 초당 소비율(소비/프로비저닝)`} padded={false}>
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">메트릭 조회 실패: {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Table', 'Billing', 'Throttle R/W', 'RCU (소비/프로비저닝)', 'WCU (소비/프로비저닝)', 'Lat Get', 'Lat Query', 'Lat Put', 'Lat Scan', 'CondFail', 'TxnConflict'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const m = fleet[String(r.resource_id)] ?? {};
              const rt = num(m.rThrottle) ?? 0; const wt = num(m.wThrottle) ?? 0;
              const throttled = rt > 0 || wt > 0;
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(r.resource_id)}</td>
                  <td className={TD}>{String(r.billing_mode ?? '—') === 'PAY_PER_REQUEST' ? 'On-Demand' : 'Provisioned'}</td>
                  <td className={`${TD} ${throttled ? danger : ''}`} title="Read/WriteThrottleEvents(5분 누적) — >0 지속이면 용량 부족 또는 핫 파티션. Contributor Insights로 핫 키 확인">
                    {num(m.rThrottle) == null && num(m.wThrottle) == null ? dash : `${rt}/${wt}`}
                  </td>
                  <td className={TD} title="ConsumedReadCapacityUnits(초당) vs ProvisionedReadCapacityUnits — 근접/초과 시 위험">{capCell(num(m.consumedR), num(m.provR))}</td>
                  <td className={TD} title="ConsumedWriteCapacityUnits(초당) vs ProvisionedWriteCapacityUnits">{capCell(num(m.consumedW), num(m.provW))}</td>
                  <td className={TD} title="SuccessfulRequestLatency(GetItem, ms)">{lat(num(m.latGet))}</td>
                  <td className={TD} title="SuccessfulRequestLatency(Query, ms) — 급증 시 액세스 패턴 의심">{lat(num(m.latQuery))}</td>
                  <td className={TD} title="SuccessfulRequestLatency(PutItem, ms)">{lat(num(m.latPut))}</td>
                  <td className={TD} title="SuccessfulRequestLatency(Scan, ms) — 풀스캔/큰 결과셋 의심">{lat(num(m.latScan))}</td>
                  <td className={TD} title="ConditionalCheckFailedRequests — 낙관적 락이면 정상 발생 가능, 맥락 판단">{cnt(num(m.condFail))}</td>
                  <td className={TD} title="TransactionConflict — 높으면 경합 심함">{cnt(num(m.txnConflict))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {replication.length > 0 && (
        <div className="border-t border-ink-100">
          <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">Global Tables 복제 지연 (ReplicationLatency, Last 1h)</div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100">
                {['Table', 'Receiving Region', 'Latency'].map((h) => <th key={h} className={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {replication.slice(0, 15).map((l, i) => (
                  <tr key={i} className="border-b border-ink-50 last:border-0">
                    <td className={MONO}>{l.table}</td>
                    <td className={MONO}>{l.region || '—'}</td>
                    <td className={`${TD} tabular`} title="리전 간 복제 지연 — 증가 추세면 경보">{l.latencyMs == null ? dash : `${Math.round(l.latencyMs).toLocaleString()} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <DdbDiagnosisGuide />
    </Card>
  );
}
