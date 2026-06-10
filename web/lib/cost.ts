// Pure cost math — no SDK, deterministic (inject `now`). Ported from v1 src/app/cost/page.tsx.

/** Month-over-month change %, signed. Returns 0 when last month is 0/missing (no baseline). */
export function momChangePct(thisMonth: number, lastMonth: number): number {
  if (!lastMonth || lastMonth <= 0) return 0;
  return ((thisMonth - lastMonth) / lastMonth) * 100;
}

/** Linear projection of month-end spend from month-to-date. `now` injected for determinism. */
export function projectMonthEnd(mtd: number, now: Date): number {
  const dayOfMonth = now.getDate();
  if (dayOfMonth <= 0) return 0;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (mtd / dayOfMonth) * daysInMonth;
}

/** Format a signed percentage as an arrow trend pill, e.g. 4.2 → "↑4.2%", -2.3 → "↓2.3%". */
export function trendPill(pct: number): string {
  const a = Math.abs(pct).toFixed(1);
  if (pct > 0) return `↑${a}%`;
  if (pct < 0) return `↓${a}%`;
  return `0.0%`;
}
