'use client';
import { useMemo } from 'react';
import Card from '@/components/ui/Card';
import DiagnosisGuide from './DiagnosisGuide';
import { RDS_GUIDE } from './guides';
import { type Row, num, dash, gb, cnt, meter, TH, TD, MONO, DANGER, useFleet } from './shared';

// RDS per-instance diagnostic table (owner 가이드: CloudWatch/복제/EM/PI 4층위).
// 임계값: CPU>80 지속=컴퓨트 병목, Free Storage 고갈=가장 흔한 장애 원인, Swap 증가=메모리 부족,
// 크레딧(BurstBalance/CPUCreditBalance) 0 근접=gp2/T계열 함정, ReplicaLag 증가=복제 지연.
export function RdsInstanceMetrics({ rows }: { rows: Row[] }) {
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('rds', ids);
  if (rows.length === 0) return null;

  const lat = (v: number | null) => (v == null ? dash : `${(v * 1000).toFixed(1)} ms`); // CloudWatch RDS latency unit = seconds

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
                  <td className={`${TD} ${freePct != null && freePct < 15 ? DANGER : ''}`} title="FreeStorageSpace — 가장 흔한 장애 원인. 고갈되면 DB 정지">
                    {freeB == null ? dash : `${(freeB / 1024 ** 3).toFixed(1)} GB${freePct != null ? ` (${freePct.toFixed(0)}%)` : ''}`}
                  </td>
                  <td className={TD}>{gb(num(m.freeMem))}</td>
                  <td className={`${TD} ${swapMb != null && swapMb > 100 ? DANGER : ''}`} title="SwapUsage — 0에 가까워야 정상. 커지면 메모리 부족 → 성능 급락">
                    {swapMb == null ? dash : `${swapMb.toFixed(0)} MB`}
                  </td>
                  <td className={TD} title="DatabaseConnections — max_connections 대비 확인">{cnt(num(m.conn))}</td>
                  <td className={TD} title="ReadLatency — 급증 시 스토리지 병목">{lat(num(m.readLat))}</td>
                  <td className={TD} title="WriteLatency — 급증 시 스토리지 병목">{lat(num(m.writeLat))}</td>
                  <td className={TD}>{num(m.readIops) == null && num(m.writeIops) == null ? dash : `${Math.round(num(m.readIops) ?? 0)}/${Math.round(num(m.writeIops) ?? 0)}`}</td>
                  <td className={TD} title="DiskQueueDepth — 높으면 스토리지 병목">{num(m.diskQueue) == null ? dash : (num(m.diskQueue) as number).toFixed(1)}</td>
                  <td className={`${TD} ${(burst != null && burst < 20) || (credit != null && credit < 50) ? DANGER : ''}`}
                      title="BurstBalance(gp2)/CPUCreditBalance(T계열) — 0 근접 시 성능 강등 (자주 놓치는 함정)">
                    {burst != null ? `${burst.toFixed(0)}%` : credit != null ? Math.round(credit).toLocaleString() : dash}
                  </td>
                  <td className={`${TD} ${replicaLag != null && replicaLag > 10 ? DANGER : ''}`} title="ReplicaLag(초) — 증가 추세면 복제 지연">
                    {replicaLag == null ? dash : `${replicaLag.toFixed(1)}s`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DiagnosisGuide spec={RDS_GUIDE} />
    </Card>
  );
}
