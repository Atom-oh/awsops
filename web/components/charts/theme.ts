/**
 * Chart theme — matches DESIGN.md §"Components catalog → Charts" exactly.
 * lead = claude-500, secondary = ink-400, tertiary/total = ink-800;
 * donut palette cycles claude-500 / ink-400 / ink-800 / claude-700 / claude-200;
 * grid dotted "2 4" in ink-100; axes/labels ink-400; tooltip = dark inverse.
 */
export const CHART = {
  lead: '#D97757', // claude-500
  leadStrong: '#8E4830', // claude-700
  secondary: '#8A8474', // ink-400
  total: '#1F1E1D', // ink-800
  grid: '#EDEBE4', // ink-100
  axis: '#8A8474', // ink-400
  paper: '#FAF9F5',
} as const;

/** Donut/series palette: claude-500, ink-400, ink-800, claude-700, claude-200. */
export const PALETTE = ['#D97757', '#8A8474', '#1F1E1D', '#8E4830', '#EEBFAA'] as const;

export const AXIS_TICK = { fill: CHART.axis, fontSize: 11 } as const;

/** Dark inverse tooltip — ink-800 bg, paper text, radius 8. */
export const TOOLTIP_STYLES = {
  contentStyle: {
    background: CHART.total,
    border: 'none',
    borderRadius: 8,
    boxShadow: '0 6px 24px rgba(31,30,29,.18)',
    padding: '8px 10px',
  },
  labelStyle: { color: CHART.paper, fontSize: 11, marginBottom: 2 },
  itemStyle: { color: CHART.paper, fontSize: 12 },
} as const;
