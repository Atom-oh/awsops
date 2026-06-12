'use client';

import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Card from '@/components/ui/Card';
import { AXIS_TICK, CHART, TOOLTIP_STYLES } from './theme';

export interface BarDistributionProps {
  title: ReactNode;
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  className?: string;
}

/**
 * BarDistribution — vertical bars in brand-500, the max bar emphasised in
 * brand-700, dotted ink-100 grid, ink-400 axes, dark inverse tooltip.
 * DESIGN.md §Charts.
 */
export default function BarDistribution({
  title,
  right,
  data,
  xKey,
  yKey,
  className,
}: BarDistributionProps) {
  const max = data.reduce((m, d) => {
    const n = Number(d[yKey]);
    return Number.isFinite(n) && n > m ? n : m;
  }, -Infinity);

  return (
    <Card title={title} right={right} className={className}>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART.grid }}
            interval={0}
            angle={-30}
            textAnchor="end"
            height={64}
          />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
          <Tooltip {...TOOLTIP_STYLES} cursor={{ fill: CHART.grid, opacity: 0.4 }} />
          <Bar dataKey={yKey} radius={[4, 4, 0, 0]} maxBarSize={40}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={Number(d[yKey]) === max ? CHART.leadStrong : CHART.lead}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
