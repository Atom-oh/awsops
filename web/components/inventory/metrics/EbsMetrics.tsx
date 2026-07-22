'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import DiagnosisGuide from './DiagnosisGuide';
import { EBS_GUIDE } from './guides';
import { type Row, type Fleet, num, dash, TH, TD, MONO, DANGER } from './shared';
import { useI18n } from '@/components/shell/LanguageProvider';

// EBS per-volume diagnostics (owner 가이드): 원시값(기간 합계)을 IOPS(/300)·MB/s·평균지연
// (TotalTime/Ops)으로 환산해 표시. 볼륨 한계 vs 인스턴스 EBS 대역폭(밸런스 테이블) 구분.

export function EbsMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 150), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [instanceBalance, setInstanceBalance] = useState<Fleet>({});
  const [instOfVol, setInstOfVol] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/ebs_volume/metrics?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (live) {
          setFleet(d.fleet ?? {}); setInstanceBalance(d.instanceBalance ?? {});
          setInstOfVol(d.instOfVol ?? {}); setErr('');
        }
      })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key]);
  if (rows.length === 0) return null;

  // gp2 baseline = 3 IOPS/GB (100~16000 clamp) — row.iops가 없을 때의 비교 기준.
  const provisionedIops = (r: Row): number | null => {
    const iops = Number(r.iops);
    if (Number.isFinite(iops) && iops > 0) return iops;
    if (String(r.volume_type) === 'gp2') {
      const size = Number(r.size);
      return Number.isFinite(size) ? Math.min(16000, Math.max(100, 3 * size)) : null;
    }
    return null;
  };

  const balanceRows = Object.entries(instanceBalance)
    .map(([iid, m]) => ({ iid, io: num(m.ioBalance), byte: num(m.byteBalance) }))
    .filter((x) => x.io != null || x.byte != null);

  return (
    <Card
      title={tt('볼륨 진단 메트릭 (Last 1h)')}
      subtitle={`${ids.length} volumes · ${tt('CloudWatch AWS/EBS · IOPS/MBps/지연은 5분 합계를 환산한 값')}`}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패:')} {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Volume', 'Type', 'Size', 'IOPS (사용/프로비저닝)', 'MB/s', '평균 지연 R/W', 'Queue', 'Burst %', 'Prov. 성능 %', 'Instance'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const m = fleet[String(r.resource_id)] ?? {};
              const rOps = num(m.readOps) ?? 0; const wOps = num(m.writeOps) ?? 0;
              const hasOps = num(m.readOps) != null || num(m.writeOps) != null;
              const iops = hasOps ? (rOps + wOps) / 300 : null;
              const prov = provisionedIops(r);
              const iopsHot = iops != null && prov != null && iops >= prov * 0.8;
              const mbps = num(m.readBytes) == null && num(m.writeBytes) == null
                ? null : ((num(m.readBytes) ?? 0) + (num(m.writeBytes) ?? 0)) / 300 / 1024 / 1024;
              const latR = rOps > 0 && num(m.totalReadTime) != null ? ((num(m.totalReadTime) as number) / rOps) * 1000 : null;
              const latW = wOps > 0 && num(m.totalWriteTime) != null ? ((num(m.totalWriteTime) as number) / wOps) * 1000 : null;
              const queue = num(m.queueLength);
              const burst = num(m.burstBalance);
              const tpPct = num(m.throughputPct);
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(r.resource_id)}</td>
                  <td className={TD}>{String(r.volume_type ?? '—')}</td>
                  <td className={TD}>{r.size != null ? `${r.size} GB` : '—'}</td>
                  <td className={`${TD} ${iopsHot ? DANGER : ''}`} title="VolumeRead+WriteOps/300 vs 프로비저닝(gp2는 3 IOPS/GB baseline) — 한계에 붙으면 볼륨 병목">
                    {iops == null ? dash : `${iops < 10 ? iops.toFixed(1) : Math.round(iops).toLocaleString()}${prov != null ? ` / ${prov.toLocaleString()}` : ''}`}
                  </td>
                  <td className={TD} title="VolumeRead+WriteBytes/300 — gp3는 IOPS와 처리량을 독립적으로 봐야 함">
                    {mbps == null ? dash : mbps.toFixed(2)}
                  </td>
                  <td className={TD} title="평균 지연 = VolumeTotalTime/Ops — 높은데 IOPS/처리량 미달이면 I/O 크기·랜덤성 문제">
                    {latR == null && latW == null ? dash : `${latR == null ? '—' : latR.toFixed(1)}/${latW == null ? '—' : latW.toFixed(1)} ms`}
                  </td>
                  <td className={`${TD} ${queue != null && queue > 8 ? DANGER : ''}`} title="VolumeQueueLength — 가장 직관적인 포화 지표. 지속적으로 높으면 볼륨이 요청을 못 따라감">
                    {queue == null ? dash : queue.toFixed(1)}
                  </td>
                  <td className={`${TD} ${burst != null && burst < 20 ? DANGER : ''}`} title="BurstBalance(gp2/st1/sc1) — 0 근접 시 baseline 강등. gp2 원인불명 성능저하의 단골 (gp3 전환 권장)">
                    {burst == null ? dash : `${burst.toFixed(0)}%`}
                  </td>
                  <td className={`${TD} ${tpPct != null && tpPct < 100 ? DANGER : ''}`} title="VolumeThroughputPercentage(io1/io2) — 100% 미만 지속 = 프로비저닝 성능 미달">
                    {tpPct == null ? dash : `${tpPct.toFixed(0)}%`}
                  </td>
                  <td className={MONO}>{instOfVol[String(r.resource_id)] ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 인스턴스 레벨 EBS 대역폭 밸런스 — 볼륨이 여유로운데 느릴 때의 범인 (소형 Nitro만 발행) */}
      {balanceRows.length > 0 && (
        <div className="border-t border-ink-100">
          <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">인스턴스 EBS 대역폭 밸런스 (Last 1h)</div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100">
                {['Instance', 'EBS IO Balance %', 'EBS Byte Balance %'].map((h) => <th key={h} className={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {balanceRows.map((b, i) => (
                  <tr key={i} className="border-b border-ink-50 last:border-0">
                    <td className={MONO}>{b.iid}</td>
                    <td className={`${TD} ${b.io != null && b.io < 20 ? DANGER : ''}`} title="EBSIOBalance% — 0 근접 시 인스턴스 EBS baseline으로 강등 (볼륨이 커도 병목)">
                      {b.io == null ? dash : `${b.io.toFixed(0)}%`}
                    </td>
                    <td className={`${TD} ${b.byte != null && b.byte < 20 ? DANGER : ''}`} title="EBSByteBalance% — 0 근접 시 인스턴스 EBS 대역폭 강등">
                      {b.byte == null ? dash : `${b.byte.toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <DiagnosisGuide spec={EBS_GUIDE} />
    </Card>
  );
}
