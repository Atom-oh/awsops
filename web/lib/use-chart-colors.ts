'use client';
import { useEffect, useState } from 'react';
import { THEME_EVENT } from './theme';

export interface ChartColors {
  lead: string;
  leadStrong: string;
  palette: string[];
}

// First-paint / SSR fallback = the default (cobalt) theme values.
const FALLBACK: ChartColors = {
  lead: '#528DF8',
  leadStrong: '#1F54C2',
  palette: ['#528DF8', '#01A88D', '#7B26FF', '#39C2B0', '#7D8A96'],
};

function read(): ChartColors {
  if (typeof window === 'undefined') return FALLBACK;
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => s.getPropertyValue(name).trim() || fb;
  return {
    lead: v('--chart-1', FALLBACK.lead),
    leadStrong: v('--brand-700', FALLBACK.leadStrong),
    palette: [
      v('--chart-1', FALLBACK.palette[0]),
      v('--chart-2', FALLBACK.palette[1]),
      v('--chart-3', FALLBACK.palette[2]),
      v('--chart-4', FALLBACK.palette[3]),
      v('--chart-5', FALLBACK.palette[4]),
    ],
  };
}

/** Resolved chart series colors that react to runtime theme changes. */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(FALLBACK);
  useEffect(() => {
    setColors(read());
    const handler = () => setColors(read());
    window.addEventListener(THEME_EVENT, handler);
    return () => window.removeEventListener(THEME_EVENT, handler);
  }, []);
  return colors;
}
