'use client';
import { useMemo } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { type Row, num, dash, cnt, ms, meter, TH, TD, MONO, useFleet } from './shared';

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
