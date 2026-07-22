'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import DiagnosisGuide from './DiagnosisGuide';
import { S3_GUIDE } from './guides';
import { type Row, type Fleet, num, dash, cnt, mb, ms, TH, TD, MONO, DANGER } from './shared';
import { useI18n } from '@/components/shell/LanguageProvider';

// S3 per-bucket diagnostics (owner 가이드): 스토리지(일별)/요청(유료, 활성화 시)/복제.
// 요청 메트릭 미활성 버킷은 '—' — 가이드의 'S3만의 특이점' 섹션이 이유를 설명한다.
interface ReplicationRow { source: string; dest: string; rule: string; latencySec: number | null; failed: number | null }

const fmtSize = (v: number | null) => {
  if (v == null) return dash;
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  return `${(v / 1024 ** 2).toFixed(1)} MB`;
};

export function S3Metrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 150), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [replication, setReplication] = useState<ReplicationRow[]>([]);
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/s3/metrics?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setReplication(d.replication ?? []); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key]);
  if (rows.length === 0) return null;

  return (
    <Card
      title={tt('버킷 진단 메트릭')}
      subtitle={`${ids.length} buckets · ${tt('크기/객체 수는 일별 집계(Standard), 요청 지표는 요청 메트릭(EntireBucket) 활성 버킷만 (Last 1h)')}`}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패:')} {err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {['Bucket', 'Size (Standard)', 'Objects', 'Requests', '4xx', '5xx', 'First Byte', 'Bytes ↓', 'Bytes ↑'].map((h) => <th key={h} className={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const m = fleet[String(r.resource_id)] ?? {};
              const e4 = num(m.req4xx); const e5 = num(m.req5xx);
              return (
                <tr key={i} className="border-b border-ink-50 last:border-0">
                  <td className={MONO}>{String(r.resource_id)}</td>
                  <td className={TD} title="BucketSizeBytes(StandardStorage, 일별) — 이상 급증 = 비용/이상 업로드">{fmtSize(num(m.sizeStd))}</td>
                  <td className={TD} title="NumberOfObjects(일별) — 급증/급감으로 대량 생성/삭제 감지">{cnt(num(m.objects))}</td>
                  <td className={TD} title="AllRequests(5분 누적) — 요청 메트릭 활성 버킷만">{cnt(num(m.allReq))}</td>
                  <td className={`${TD} ${e4 != null && e4 > 0 ? DANGER : ''}`} title="4xxErrors — 급증 시 권한(403)/경로(404) 문제, CloudTrail 데이터 이벤트로 추적">{cnt(e4)}</td>
                  <td className={`${TD} ${e5 != null && e5 > 0 ? DANGER : ''}`} title="5xxErrors — 503 SlowDown이면 핫 프리픽스(프리픽스당 3,500w/5,500r 한도)">{cnt(e5)}</td>
                  <td className={TD} title="FirstByteLatency — 급증 = S3 처리 지연 (TotalRequestLatency와 구분)">{ms(num(m.firstByte))}</td>
                  <td className={TD} title="BytesDownloaded(5분 누적)">{mb(num(m.bytesDown))}</td>
                  <td className={TD} title="BytesUploaded(5분 누적)">{mb(num(m.bytesUp))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* CRR/SRR 복제 상태 — Source/Dest/RuleId 차원은 ListMetrics로 발견 (복제 룰 있는 계정만 표시) */}
      {replication.length > 0 && (
        <div className="border-t border-ink-100">
          <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">복제 상태 (CRR/SRR, Last 1h)</div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100">
                {['Source', 'Destination', 'Rule', 'Latency', 'Failed'].map((h) => <th key={h} className={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {replication.slice(0, 15).map((l, i) => (
                  <tr key={i} className="border-b border-ink-50 last:border-0">
                    <td className={MONO}>{l.source}</td>
                    <td className={MONO}>{l.dest || '—'}</td>
                    <td className={MONO}>{l.rule || '—'}</td>
                    <td className={`${TD} ${l.latencySec != null && l.latencySec > 900 ? DANGER : ''}`} title="ReplicationLatency — RTC SLA 15분(900초) 초과 시 경보">
                      {l.latencySec == null ? dash : `${Math.round(l.latencySec).toLocaleString()}s`}
                    </td>
                    <td className={`${TD} ${l.failed != null && l.failed > 0 ? DANGER : ''}`} title="OperationsFailedReplication — >0이면 권한/설정 문제 조사">
                      {l.failed == null ? dash : Math.round(l.failed).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <DiagnosisGuide spec={S3_GUIDE} />
    </Card>
  );
}
