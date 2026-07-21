'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import DiagnosisGuide from './DiagnosisGuide';
import { ALB_GUIDE } from './guides';
import TgHealthTable, { type TgHealthRow } from './TgHealthTable';
import { type Row, type Fleet, num, dash, cnt, TH, TD, MONO, DANGER } from './shared';

// ALB per-LB diagnostics (owner 가이드): ELB가 낸 에러 vs 타깃이 낸 에러 구분 + p50/p99 지연 +
// 연결 거부/타깃 연결 실패 + 타깃그룹 헬스. 응답은 {fleet(resource_id 키), targetHealth, lbDimByResource}.
export function AlbMetrics({ rows }: { rows: Row[] }) {
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 100), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [health, setHealth] = useState<TgHealthRow[]>([]);
  const [lbDims, setLbDims] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/alb/metrics?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setHealth(d.targetHealth ?? []); setLbDims(d.lbDimByResource ?? {}); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key]);
  if (rows.length === 0) return null;

  const secs = (v: number | null) => (v == null ? dash : `${(v * 1000).toFixed(0)} ms`); // TargetResponseTime unit = seconds

  return (
    <Card title="LB 진단 메트릭 (Last 1h)" subtitle={`${ids.length} load balancers · CloudWatch AWS/ApplicationELB · ELB 에러(LB 자체) vs Target 에러(백엔드) 구분`} padded={false}>
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">메트릭 조회 실패: {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['ALB', 'Requests', 'ELB 5xx (502/503/504)', 'Target 5xx', 'Target 2xx', 'Resp p50', 'Resp p99', 'Active', 'Rejected', 'Tgt Conn Err', 'TLS Err', 'LCU'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const m = fleet[String(r.resource_id)] ?? {};
              const elb5 = num(m.elb5xx); const t5 = num(m.tgt5xx);
              const rej = num(m.rejected); const connErr = num(m.tgtConnErr);
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(r.resource_id)}</td>
                  <td className={TD} title="RequestCount(5분 누적) — 트래픽 기준선">{cnt(num(m.requests))}</td>
                  <td className={`${TD} ${elb5 != null && elb5 > 0 ? DANGER : ''}`} title="HTTPCode_ELB_5XX — LB↔타깃 문제. 502=타깃 연결 끊김/keep-alive 불일치, 503=정상 타깃 없음, 504=백엔드 타임아웃">
                    {elb5 == null ? dash : `${cnt(elb5)} (${cnt(num(m.elb502))}/${cnt(num(m.elb503))}/${cnt(num(m.elb504))})`}
                  </td>
                  <td className={`${TD} ${t5 != null && t5 > 0 ? DANGER : ''}`} title="HTTPCode_Target_5XX — 백엔드 애플리케이션 오류">{cnt(t5)}</td>
                  <td className={TD} title="HTTPCode_Target_2XX — 정상 트래픽 기준선">{cnt(num(m.tgt2xx))}</td>
                  <td className={TD} title="TargetResponseTime p50">{secs(num(m.respP50))}</td>
                  <td className={TD} title="TargetResponseTime p99 — 평균은 롱테일을 숨김, 급증=백엔드 성능 저하">{secs(num(m.respP99))}</td>
                  <td className={TD} title="ActiveConnectionCount">{cnt(num(m.active))}</td>
                  <td className={`${TD} ${rej != null && rej > 0 ? DANGER : ''}`} title="RejectedConnectionCount — >0이면 ALB 연결 한도 도달(용량 문제)">{cnt(rej)}</td>
                  <td className={`${TD} ${connErr != null && connErr > 0 ? DANGER : ''}`} title="TargetConnectionErrorCount — ALB→타깃 연결 실패(네트워크/SG/포트)">{cnt(connErr)}</td>
                  <td className={TD} title="ClientTLSNegotiationErrorCount">{cnt(num(m.clientTlsErr))}</td>
                  <td className={TD} title="ConsumedLCUs(5분 누적) — 용량/요금 산정, 급증 감지">{num(m.lcu) == null ? dash : (num(m.lcu) as number).toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TgHealthTable health={health} lbDims={lbDims} />

      <DiagnosisGuide spec={ALB_GUIDE} />
    </Card>
  );
}
