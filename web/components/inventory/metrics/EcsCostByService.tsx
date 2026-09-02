'use client';
import { useMemo } from 'react';
import GroupedBarList from '@/components/charts/GroupedBarList';
import { useI18n } from '@/components/shell/LanguageProvider';
import { estimateDailyParts } from '@/lib/cost-basis';
import type { Row } from './shared';

// Cost by Service — CPU vs Memory grouped bar (gap L195, v1 container-cost parity): FARGATE
// tasks group by their task_group's `service:` name, and the CPU/Memory daily-cost split
// comes from the SHARED estimateDailyParts (the batch-25 single-source rule — the same
// constants the table's Daily $ column computes with). EC2 launch-type tasks and tasks
// without a service group are EXCLUDED — the deriver gives them no estimate, and a bar must
// not mix estimated and unestimated populations. Named export per the metrics-module
// convention.

const usd = (v: number) => `$${v.toFixed(2)}`;

export function EcsCostByService({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const data = useMemo(() => {
    const byService = new Map<string, { cpu: number; mem: number }>();
    for (const r of rows) {
      if (String(r.launch_type ?? '').toUpperCase() !== 'FARGATE') continue;
      const g = String(r.task_group ?? '');
      if (!g.startsWith('service:')) continue;
      const cpu = Number(r.cpu);
      const mem = Number(r.memory);
      if (!Number.isFinite(cpu) || !Number.isFinite(mem)) continue;
      const parts = estimateDailyParts(cpu / 1024, mem / 1024);
      const e = byService.get(g.slice('service:'.length)) ?? { cpu: 0, mem: 0 };
      e.cpu += parts.cpu; e.mem += parts.ram;
      byService.set(g.slice('service:'.length), e);
    }
    return [...byService.entries()]
      .map(([service, v]) => ({ service, cpu: Math.round(v.cpu * 100) / 100, mem: Math.round(v.mem * 100) / 100 }))
      .sort((a, b) => (b.cpu + b.mem) - (a.cpu + a.mem))
      .slice(0, 10);
  }, [rows]);

  if (data.length === 0) return null;
  return (
    <GroupedBarList
      title={tt('서비스별 비용 (일간, CPU vs Memory)')}
      data={data}
      labelKey="service"
      series={[
        { key: 'cpu', label: 'CPU', color: '#3D6FB5', fmt: usd },
        { key: 'mem', label: 'Memory', color: '#8A5BD0', fmt: usd },
      ]}
    />
  );
}

export default EcsCostByService;
