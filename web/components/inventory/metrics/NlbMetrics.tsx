'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import DiagnosisGuide from './DiagnosisGuide';
import { NLB_GUIDE } from './guides';
import TgHealthTable, { type TgHealthRow } from './TgHealthTable';
import { type Row, type Fleet, num, dash, cnt, mb, TH, TD, MONO, DANGER } from './shared';

// NLB per-LB diagnostics (owner 가이드): L4 — HTTP 코드가 없어 RST 카운트/타깃 헬스가 핵심.
// 응답: {fleet(resource_id 키), targetHealth, lbDimByResource} — ALB와 동일 계약(net/ 차원).
export function NlbMetrics({ rows }: { rows: Row[] }) {
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 100), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [health, setHealth] = useState<TgHealthRow[]>([]);
  const [lbDims, setLbDims] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/nlb/metrics?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setHealth(d.targetHealth ?? []); setLbDims(d.lbDimByResource ?? {}); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key]);
  if (rows.length === 0) return null;

  return (
    <Card title="LB 진단 메트릭 (Last 1h)" subtitle={`${ids.length} load balancers · CloudWatch AWS/NetworkELB · L4: RST 카운트와 타깃 헬스가 진단의 핵심`} padded={false}>
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">메트릭 조회 실패: {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['NLB', 'Active Flow', 'New Flow', 'Target RST', 'ELB RST', 'Client RST', 'Processed', 'Port Alloc Err', 'Unhealthy Routing', 'TLS Err (C/T)', 'LCU'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const m = fleet[String(r.resource_id)] ?? {};
              const portErr = num(m.portAllocErr); const unhealthyRt = num(m.unhealthyRouting);
              const cTls = num(m.clientTlsErr); const tTls = num(m.targetTlsErr);
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(r.resource_id)}</td>
                  <td className={TD} title="ActiveFlowCount — 활성 플로우, 급증/급감으로 트래픽 이상 감지">{cnt(num(m.activeFlow))}</td>
                  <td className={TD} title="NewFlowCount(5분 누적) — 연결 수립률">{cnt(num(m.newFlow))}</td>
                  <td className={TD} title="TCP_Target_Reset_Count — 타깃발 RST 급증 = 백엔드 문제 강한 신호 (앱 크래시/포트 닫힘/백로그 초과)">{cnt(num(m.tgtRst))}</td>
                  <td className={TD} title="TCP_ELB_Reset_Count — NLB발 RST 급증 = idle timeout(350초)/비대칭 라우팅">{cnt(num(m.elbRst))}</td>
                  <td className={TD} title="TCP_Client_Reset_Count — 클라이언트발 RST">{cnt(num(m.clientRst))}</td>
                  <td className={TD} title="ProcessedBytes(5분 누적)">{mb(num(m.processedBytes))}</td>
                  <td className={`${TD} ${portErr != null && portErr > 0 ? DANGER : ''}`} title="PortAllocationErrorCount — SNAT 소스 포트 고갈, >0이면 연결 실패 발생 (놓치기 쉬운 원인)">{cnt(portErr)}</td>
                  <td className={`${TD} ${unhealthyRt != null && unhealthyRt > 0 ? DANGER : ''}`} title="UnhealthyRoutingFlowCount — 정상 타깃이 없어 라우팅 실패한 플로우">{cnt(unhealthyRt)}</td>
                  <td className={`${TD} ${(cTls != null && cTls > 0) || (tTls != null && tTls > 0) ? DANGER : ''}`} title="Client/TargetTLSNegotiationErrorCount — TLS 협상 실패">
                    {cTls == null && tTls == null ? dash : `${cnt(cTls)}/${cnt(tTls)}`}
                  </td>
                  <td className={TD} title="ConsumedLCUs(5분 누적)">{num(m.lcu) == null ? dash : (num(m.lcu) as number).toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TgHealthTable health={health} lbDims={lbDims} />

      <DiagnosisGuide spec={NLB_GUIDE} />
    </Card>
  );
}
