/**
 * Chart theme — AgentCore palette (Bedrock teal lead). recharts renders colors
 * as SVG attributes, which don't accept CSS var(), so these are concrete hex
 * and identical across themes. DOM/CSS chart bits use the --chart-* variables.
 * lead = teal #01A88D; series cycle teal / blue / violet / light-teal / ink-400;
 * grid dotted in ink-100; axes/labels ink-400; tooltip = dark inverse (ink-800).
 */
export const CHART = {
  lead: '#01A88D', // brand teal (chart-1)
  leadStrong: '#00715D', // deep teal
  secondary: '#528DF8', // blue (chart-2)
  total: '#16202A', // ink-800
  grid: '#E7ECEF', // ink-100
  axis: '#7D8A96', // ink-400
  paper: '#F4F6F8',
} as const;

/** Donut/series palette: teal, blue, violet, light-teal, ink-400. */
export const PALETTE = ['#01A88D', '#528DF8', '#7B26FF', '#39C2B0', '#7D8A96'] as const;

export const AXIS_TICK = { fill: CHART.axis, fontSize: 11 } as const;

/** Dark inverse tooltip — ink-800 bg, paper text, radius 8. */
export const TOOLTIP_STYLES = {
  contentStyle: {
    background: CHART.total,
    border: 'none',
    borderRadius: 8,
    boxShadow: '0 6px 24px rgba(16,32,42,.18)',
    padding: '8px 10px',
  },
  labelStyle: { color: CHART.paper, fontSize: 11, marginBottom: 2 },
  itemStyle: { color: CHART.paper, fontSize: 12 },
} as const;
