'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import DiagnosisGuide from './DiagnosisGuide';
import { MSK_GUIDE } from './guides';
import { type Row, type Fleet, num, dash, kbps, cnt, meter, TH, TD, MONO, useFleet, HealthPill } from './shared';
import { useI18n } from '@/components/shell/LanguageProvider';

// ── MSK: broker/controller node rows (kafka ListNodes + per-broker CloudWatch) ──
interface MskNodeRow { nodeType: string; brokerId: number | null; instanceType: string | null; clientVpcIp: string | null; eni: string | null; endpoints: string[] }
interface MskLagRow { consumerGroup: string; topic: string; maxOffsetLag: number | null }
interface MskClusterData { nodes: MskNodeRow[]; brokerMetrics: Fleet; health?: Record<string, number | null>; lags?: MskLagRow[] }

export function MskBrokerNodes({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
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
      title={tt('Broker Nodes · 클러스터 건강성')}
      subtitle={`${brokers.length} brokers · ${controllers.length} controllers · CloudWatch AWS/Kafka (${tt('브로커 단위, Last 1h')})`}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('노드 조회 실패:')} {err}</div>}

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

      <DiagnosisGuide spec={MSK_GUIDE} />
    </Card>
  );
}
