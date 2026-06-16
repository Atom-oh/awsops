'use client';

import type { ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import Card from '@/components/ui/Card';
import { useChartColors } from '@/lib/use-chart-colors';
import { tooltipStyles } from './theme';

export interface DonutBreakdownProps {
  title: ReactNode;
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  nameKey: string;
  valueKey: string;
  /** Prefix legend/center values (e.g. "$"). */
  valuePrefix?: string;
  className?: string;
}

/**
 * DonutBreakdown — PieChart innerRadius 55 / outerRadius 80, palette cycling
 * brand-500 / ink-400 / ink-800 / brand-700 / brand-200, a center total
 * label, and a side legend list. DESIGN.md §Charts.
 */
export default function DonutBreakdown({
  title,
  right,
  data,
  nameKey,
  valueKey,
  valuePrefix = '',
  className,
}: DonutBreakdownProps) {
  const c = useChartColors();
  const total = data.reduce((s, d) => s + (Number(d[valueKey]) || 0), 0);
  const fmtTotal =
    valuePrefix === '$'
      ? `$${Math.round(total).toLocaleString()}`
      : total.toLocaleString();

  return (
    <Card title={title} right={right} className={className}>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0" style={{ width: 170, height: 170 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey={valueKey}
                nameKey={nameKey}
                innerRadius={55}
                outerRadius={80}
                paddingAngle={2}
                stroke="none"
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={c.palette[i % c.palette.length]} />
                ))}
              </Pie>
              <Tooltip
                {...tooltipStyles(c)}
                formatter={(v, n) =>
                  [
                    valuePrefix === '$'
                      ? `$${Math.round(Number(v)).toLocaleString()}`
                      : Number(v).toLocaleString(),
                    n as string,
                  ] as [string, string]
                }
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="tabular text-[20px] font-semibold leading-none text-ink-800">
              {fmtTotal}
            </div>
            <div className="text-[10px] uppercase tracking-[0.04em] text-ink-400 mt-1">합계</div>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {data.map((d, i) => (
            <li key={i} className="flex items-center gap-2 text-[12px]">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: c.palette[i % c.palette.length] }}
              />
              <span className="min-w-0 flex-1 truncate text-ink-600">{String(d[nameKey])}</span>
              <span className="tabular shrink-0 font-medium text-ink-800">
                {valuePrefix === '$'
                  ? `$${Math.round(Number(d[valueKey])).toLocaleString()}`
                  : Number(d[valueKey]).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
