'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import DiagnosisGuide from './DiagnosisGuide';
import { EC2_GUIDE } from './guides';
import { type Row, type Fleet, num, dash, meter, TH, TD, MONO, DANGER } from './shared';
import { useI18n } from '@/components/shell/LanguageProvider';

// EC2 per-instance diagnostics (owner 가이드): 상태 점검 System/Instance/EBS 구분(책임 소재),
// T계열 크레딧, 네트워크 Mbps/PPS(합계/300 환산), 인스턴스 관점 EBS IOPS·밸런스.
// 중지 인스턴스·미발행 메트릭(비-T 크레딧, 비-Nitro 밸런스)은 정직한 '—'.

export function Ec2Metrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 150), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/ec2/metrics?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key]);
  if (rows.length === 0) return null;

  const mbps = (v: number | null) => (v == null ? dash : `${((v / 300) * 8 / 1e6).toFixed(2)}`);
  const pps = (v: number | null) => (v == null ? dash : Math.round(v / 300).toLocaleString());

  return (
    <Card
      title={tt('인스턴스 진단 메트릭 (Last 1h)')}
      subtitle={`${ids.length} instances · ${tt('CloudWatch AWS/EC2 · 메모리/디스크는 기본 메트릭에 없음(CloudWatch Agent 필요 — 가이드 참조)')}`}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패:')} {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Instance', 'Name', 'Type', 'CPU', 'CPU Credit', 'Status (Sys/Inst/EBS)', 'Net In/Out (Mbps)', 'PPS In/Out', 'EBS IOPS R/W', 'IO Bal %', 'Byte Bal %'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const m = fleet[String(r.resource_id)] ?? {};
              const credit = num(m.cpuCredit);
              const sSys = num(m.statusSystem); const sInst = num(m.statusInstance); const sEbs = num(m.statusEbs);
              const anyStatus = sSys != null || sInst != null || sEbs != null;
              const statusFail = (sSys ?? 0) >= 1 || (sInst ?? 0) >= 1 || (sEbs ?? 0) >= 1;
              const ioBal = num(m.ioBalance); const byteBal = num(m.byteBalance);
              const rIops = num(m.ebsReadOps); const wIops = num(m.ebsWriteOps);
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(r.resource_id)}</td>
                  <td className={TD}>{String(r.name ?? '—')}</td>
                  <td className={MONO}>{String(r.instance_type ?? '—')}</td>
                  <td className={TD} title="CPUUtilization — 지속 80% 초과 시 확장/타입 변경 검토 (하이퍼바이저 관점)">{meter(num(m.cpu))}</td>
                  <td className={`${TD} ${credit != null && credit < 50 ? DANGER : ''}`} title="CPUCreditBalance(T계열 전용) — 0 근접 시 baseline 강등/추가 과금. 원인불명 성능저하의 단골">
                    {credit == null ? dash : Math.round(credit).toLocaleString()}
                  </td>
                  <td className={`${TD} ${statusFail ? DANGER : ''}`} title="StatusCheckFailed System/Instance/AttachedEBS — System=AWS 인프라(stop/start로 이전), Instance=OS 내부(로그/스크린샷 조사)">
                    {!anyStatus ? dash : statusFail
                      ? `FAIL (${(sSys ?? 0) >= 1 ? 'Sys' : ''}${(sInst ?? 0) >= 1 ? ' Inst' : ''}${(sEbs ?? 0) >= 1 ? ' EBS' : ''})`.replace('( ', '(')
                      : 'OK'}
                  </td>
                  <td className={TD} title="NetworkIn/Out → Mbps 환산(합계/300×8) — 인스턴스 타입 대역폭 상한 대비">
                    {num(m.netIn) == null && num(m.netOut) == null ? dash : `${mbps(num(m.netIn))}/${mbps(num(m.netOut))}`}
                  </td>
                  <td className={TD} title="NetworkPacketsIn/Out → PPS 환산(/300) — PPS 상한 감지">
                    {num(m.pktIn) == null && num(m.pktOut) == null ? dash : `${pps(num(m.pktIn))}/${pps(num(m.pktOut))}`}
                  </td>
                  <td className={TD} title="EBSRead/WriteOps → IOPS(/300) — 인스턴스 관점 EBS I/O">
                    {rIops == null && wIops == null ? dash : `${Math.round((rIops ?? 0) / 300)}/${Math.round((wIops ?? 0) / 300)}`}
                  </td>
                  <td className={`${TD} ${ioBal != null && ioBal < 20 ? DANGER : ''}`} title="EBSIOBalance% — 0 근접 시 인스턴스 EBS baseline 강등 (볼륨이 커도 병목)">
                    {ioBal == null ? dash : `${ioBal.toFixed(0)}%`}
                  </td>
                  <td className={`${TD} ${byteBal != null && byteBal < 20 ? DANGER : ''}`} title="EBSByteBalance% — 0 근접 시 인스턴스 EBS 대역폭 강등">
                    {byteBal == null ? dash : `${byteBal.toFixed(0)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DiagnosisGuide spec={EC2_GUIDE} />
    </Card>
  );
}
