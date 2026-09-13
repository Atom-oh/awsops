'use client';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import { StackBar } from './NodeCapacityCards';
import NodeResourceMeters from './NodeResourceMeters';

// Fleet nodes capacity visualization (gap L132, v1 parity): one row per node with 3-segment
// CPU/Memory stacked bars (Requested / Available / System-Reserved) and v1's 'avail X | rsv Y'
// captions. Requested comes from the per-cluster pods fleet aggregated by cluster|node; a
// cluster whose pods fetch failed renders the Allocatable/Reserved split with a '요청량 미상'
// caption — never a fabricated zero-requested bar.

export interface NodeCapacityRow {
  cluster: string;
  name: string;
  cpuCapacity: number; cpuAllocatable: number; cpuRequest: number | null;
  memCapacityMiB: number; memAllocatableMiB: number; memRequestMiB: number | null;
  cpuUsage?: number | null; memUsageMiB?: number | null;
  usageTimestamp?: string | null;
}

const MAX_RENDER = 40;

const gib = (mib: number) => (mib >= 1024 ? `${(mib / 1024).toFixed(1)}G` : `${Math.round(mib)}M`);

function caption(requested: number | null, allocatable: number, capacity: number, fmt: (v: number) => string, unknownText: string): string {
  const rsv = Math.max(0, capacity - allocatable);
  if (requested == null) return `${unknownText} | rsv ${fmt(rsv)}`;
  const avail = Math.max(0, allocatable - Math.min(requested, allocatable));
  return `avail ${fmt(avail)} | rsv ${fmt(rsv)}`;
}

export default function NodeCapacityList({ rows, requestsPending = false }: { rows: NodeCapacityRow[]; requestsPending?: boolean }) {
  const { tt } = useI18n();
  if (!rows.length) return null;
  // Cap order: UNKNOWN-request rows first (a failed pods read must stay visible — truncating
  // the degraded rows away would mask the degradation), then by PRESSURE desc (max of cpu/mem
  // request ratio) so saturated nodes are never hidden either.
  const unknown = (n: NodeCapacityRow) => n.cpuRequest == null || n.memRequestMiB == null;
  const pressure = (n: NodeCapacityRow) => Math.max(
    n.cpuAllocatable > 0 && n.cpuRequest != null ? n.cpuRequest / n.cpuAllocatable : 0,
    n.memAllocatableMiB > 0 && n.memRequestMiB != null ? n.memRequestMiB / n.memAllocatableMiB : 0,
    n.cpuAllocatable > 0 && n.cpuUsage != null ? n.cpuUsage / n.cpuAllocatable : 0,
    n.memAllocatableMiB > 0 && n.memUsageMiB != null ? n.memUsageMiB / n.memAllocatableMiB : 0,
  );
  const shown = rows.length > MAX_RENDER
    ? [...rows].sort((a, b) => (Number(unknown(b)) - Number(unknown(a))) || (pressure(b) - pressure(a))).slice(0, MAX_RENDER)
    : rows;
  // Pending (pods fan-out in flight) reads '로딩 중', failed reads '미상' — never conflated.
  const unknownText = requestsPending ? tt('요청량 로딩 중…') : tt('요청량 미상');
  const cpuFmt = (v: number) => `${v.toFixed(1)} vCPU`;
  return (
    <Card
      title={tt('노드 리소스 (Allocated / Usage)')}
      subtitle={tt('Allocated = Pod 요청 합계 · Usage = Metrics API 실측 · 비율은 Allocatable 기준 · Usage 미수집은 별도 표시')}
      padded={false}
    >
      {rows.length > MAX_RENDER && (
        <div className="px-3 pt-2 text-[11.5px] text-amber-700">
          {shown.length} / {rows.length} {tt('노드 표시 — 필터로 좁혀보세요')}
        </div>
      )}
      <div className="divide-y divide-ink-50">
        {shown.map((n) => (
          <div key={`${n.cluster}|${n.name}`} className="grid grid-cols-1 gap-2 px-3 py-2.5 md:grid-cols-[minmax(180px,1.2fr)_1fr_1fr] md:items-center md:gap-4">
            <div className="min-w-0">
              <div className="truncate font-mono text-[11.5px] text-ink-700" title={n.name}>{n.name}</div>
              <div className="truncate font-mono text-[10.5px] text-ink-400">{n.cluster}</div>
            </div>
            <div>
              <NodeResourceMeters resource="CPU" allocated={n.cpuRequest} usage={n.cpuUsage}
                allocatable={n.cpuAllocatable} unit="cpu" usageTimestamp={n.usageTimestamp} />
              <div className="mb-0.5 flex items-baseline justify-between text-[10.5px] text-ink-400">
                <span>CPU {n.cpuCapacity.toFixed(1)} vCPU</span>
                <span>{caption(n.cpuRequest, n.cpuAllocatable, n.cpuCapacity, cpuFmt, unknownText)}</span>
              </div>
              <StackBar requested={n.cpuRequest} allocatable={n.cpuAllocatable} capacity={n.cpuCapacity} />
            </div>
            <div>
              <NodeResourceMeters resource="Memory" allocated={n.memRequestMiB} usage={n.memUsageMiB}
                allocatable={n.memAllocatableMiB} unit="memory" usageTimestamp={n.usageTimestamp} />
              <div className="mb-0.5 flex items-baseline justify-between text-[10.5px] text-ink-400">
                <span>Mem {gib(n.memCapacityMiB)}</span>
                <span>{caption(n.memRequestMiB, n.memAllocatableMiB, n.memCapacityMiB, gib, unknownText)}</span>
              </div>
              <StackBar requested={n.memRequestMiB} allocatable={n.memAllocatableMiB} capacity={n.memCapacityMiB} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
