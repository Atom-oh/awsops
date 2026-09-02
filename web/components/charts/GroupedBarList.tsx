'use client';

import type { ReactNode } from 'react';
import Card from '@/components/ui/Card';

// GroupedBarList (gap L195/L218) — the multi-series sibling of HBarList: per row, one thin
// track PER SERIES, each scaled to ITS OWN series max. Per-series scaling is the honest
// equivalent of v1's dual-axis charts (two series, two scales): a shared scale would let a
// large series visually flatten the other, while the formatted value labels carry the real
// numbers/units. Rows keep the caller's order (callers sort by their own total).

export interface GroupedSeries {
  key: string;
  label: string;
  /** track fill color (a fixed semantic tone per series — the legend chips reuse it). */
  color: string;
  fmt?: (v: number) => string;
}

export default function GroupedBarList({
  title,
  right,
  data,
  labelKey,
  series,
  className,
}: {
  title: ReactNode;
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  labelKey: string;
  series: GroupedSeries[];
  className?: string;
}) {
  const max: Record<string, number> = {};
  for (const s of series) {
    max[s.key] = Math.max(0, ...data.map((d) => Number(d[s.key]) || 0));
  }
  return (
    <Card
      title={title}
      right={
        <span className="flex items-center gap-3">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1 text-[11px] text-ink-500">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          {right}
        </span>
      }
      className={className}
    >
      <ul className="space-y-3">
        {data.map((d, i) => (
          <li key={i}>
            <div className="mb-1 truncate text-[12px] text-ink-600" title={String(d[labelKey])}>
              {String(d[labelKey])}
            </div>
            <div className="flex flex-col gap-1">
              {series.map((s) => {
                const n = Number(d[s.key]) || 0;
                const pct = max[s.key] > 0 && n > 0 ? Math.max(2, (n / max[s.key]) * 100) : 0;
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-muted">
                      <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: s.color }} />
                    </span>
                    <span className="tabular w-24 shrink-0 text-right text-[11.5px] text-ink-700">
                      {(s.fmt ?? ((v: number) => v.toLocaleString()))(n)}
                    </span>
                  </div>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
