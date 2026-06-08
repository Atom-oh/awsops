'use client';

import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Card from '@/components/ui/Card';
import { AXIS_TICK, CHART, TOOLTIP_STYLES } from './theme';

export interface AreaTrendProps {
  title: ReactNode;
  /** Right slot in the Card header (e.g. a SegmentedControl). */
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  /** Prefix the y values/tooltip with this (e.g. "$"). */
  valuePrefix?: string;
  className?: string;
}

/**
 * AreaTrend — claude-orange gradient area over a dotted ink-100 grid.
 * Lead series claude-500, fill = vertical gradient #D97757 0.30 → 0.02,
 * axes/labels ink-400, dark inverse tooltip. DESIGN.md §Charts.
 */
export default function AreaTrend({
  title,
  right,
  data,
  xKey,
  yKey,
  valuePrefix = '',
  className,
}: AreaTrendProps) {
  const fmt = (v: number | string) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return String(v);
    const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
    return `${valuePrefix}${rounded.toLocaleString()}`;
  };
  const gid = `area-${yKey}`;

  return (
    <Card title={title} right={right} className={className}>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.lead} stopOpacity={0.3} />
              <stop offset="100%" stopColor={CHART.lead} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART.grid }}
            minTickGap={24}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v) => fmt(v as number)}
          />
          <Tooltip {...TOOLTIP_STYLES} formatter={(v) => [fmt(v as number), ''] as [string, string]} />
          <Area
            type="monotone"
            dataKey={yKey}
            stroke={CHART.lead}
            strokeWidth={2}
            fill={`url(#${gid})`}
            dot={false}
            activeDot={{ r: 4, fill: CHART.lead, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}
