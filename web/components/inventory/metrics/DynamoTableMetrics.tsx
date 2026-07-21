'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import DiagnosisGuide from './DiagnosisGuide';
import { DDB_GUIDE } from './guides';
import { type Row, type Fleet, num, dash, cnt, TH, TD, MONO, DANGER } from './shared';

// DynamoDB per-table diagnostics (owner 가이드: 스로틀링·용량·지연·에러·Global Tables).
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

  const lat = (v: number | null) => (v == null ? dash : `${v.toFixed(1)}`); // SuccessfulRequestLatency is already ms
  // 소비 용량: Sum(5분) → 초당 소비율. Provisioned와 직접 비교 (근접/초과 = 위험).
  const rate = (sum: number | null) => (sum == null ? null : sum / 300);
  const capCell = (consumed: number | null, prov: number | null) => {
    const c = rate(consumed);
    if (c == null && prov == null) return dash;
    const provisioned = prov != null && prov > 0 ? prov : null;
    const hot = provisioned != null && c != null && c >= provisioned * 0.8;
    return (
      <span className={hot ? DANGER : undefined}>
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
                  <td className={`${TD} ${throttled ? DANGER : ''}`} title="Read/WriteThrottleEvents(5분 누적) — >0 지속이면 용량 부족 또는 핫 파티션. Contributor Insights로 핫 키 확인">
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

      <DiagnosisGuide spec={DDB_GUIDE} />
    </Card>
  );
}
