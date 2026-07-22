'use client';
import { useMemo } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import DiagnosisGuide from './DiagnosisGuide';
import { OS_GUIDE } from './guides';
import { type Row, num, dash, cnt, ms, meter, TH, TD, MONO, DANGER, useFleet } from './shared';
import { useI18n } from '@/components/shell/LanguageProvider';

// ── OpenSearch: per-domain metric rows (v1 도메인 메트릭) ──
export function OpensearchDomainMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('opensearch', ids);
  if (rows.length === 0) return null;

  return (
    <Card title={tt('도메인 메트릭 (Last 1h)')} subtitle={`${ids.length} domains · CloudWatch AWS/ES`} padded={false}>
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패:')} {err}</div>}
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

      {/* 진단 지표 (owner 가이드): 쓰기 차단·스레드풀 큐/거부·마스터 병목·스냅샷 실패 — 포화 신호 */}
      <div className="border-t border-ink-100">
        <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">진단 지표 (Last 1h)</div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-ink-100">
              {['Domain', 'Writes Blocked', 'Master CPU', 'Search Queue', 'Write Queue', 'Search Rejected', 'Write Rejected', 'Disk Queue', '5xx', 'Snapshot Fail'].map((h) => <th key={h} className={TH}>{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const m = fleet[String(r.resource_id)] ?? {};
                const blocked = num(m.writesBlocked);
                const sRej = num(m.searchRejected); const wRej = num(m.writeRejected);
                const snapFail = num(m.snapshotFail);
                const err5xx = num(m.http5xx);
                return (
                  <tr key={i} className="border-b border-ink-50 last:border-0">
                    <td className={MONO}>{String(r.resource_id)}</td>
                    <td className={`${TD} ${blocked != null && blocked >= 1 ? DANGER : ''}`} title="ClusterIndexWritesBlocked — 값 1 = 쓰기 차단 (디스크 부족/JVM 압박/red). 매우 중요한 경보 지표">
                      {blocked == null ? dash : blocked >= 1 ? 'BLOCKED' : 'OK'}
                    </td>
                    <td className={TD} title="MasterCPUUtilization — 전용 마스터 포화 시 샤드 할당·상태 갱신 지연">{meter(num(m.masterCpu))}</td>
                    <td className={TD} title="ThreadpoolSearchQueue — 큐가 쌓이면 검색 처리 지연 중">{cnt(num(m.searchQueue))}</td>
                    <td className={TD} title="ThreadpoolWriteQueue — 큐가 쌓이면 인덱싱 처리 지연 중">{cnt(num(m.writeQueue))}</td>
                    <td className={`${TD} ${sRej != null && sRej > 0 ? DANGER : ''}`} title="ThreadpoolSearchRejected — >0이면 클라이언트가 에러를 받는 중 → 즉시 조사">
                      {cnt(sRej)}
                    </td>
                    <td className={`${TD} ${wRej != null && wRej > 0 ? DANGER : ''}`} title="ThreadpoolWriteRejected — >0이면 쓰기 거부(포화) → 즉시 조사">
                      {cnt(wRej)}
                    </td>
                    <td className={TD} title="DiskQueueDepth — 높으면 I/O 병목">{num(m.diskQueue) == null ? dash : (num(m.diskQueue) as number).toFixed(1)}</td>
                    <td className={`${TD} ${err5xx != null && err5xx > 0 ? DANGER : ''}`} title="5xx(5분 누적) — 급증 시 서버 측 이상">{cnt(err5xx)}</td>
                    <td className={`${TD} ${snapFail != null && snapFail >= 1 ? DANGER : ''}`} title="AutomatedSnapshotFailure — 값 1 = 자동 스냅샷(백업) 실패">
                      {snapFail == null ? dash : snapFail >= 1 ? 'FAIL' : 'OK'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DiagnosisGuide spec={OS_GUIDE} />
    </Card>
  );
}
