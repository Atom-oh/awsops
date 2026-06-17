// Pure cost math — no SDK, deterministic (inject `now`). Ported from v1 src/app/cost/page.tsx.

/** Month-over-month change %, signed. Returns 0 when last month is 0/missing (no baseline). */
export function momChangePct(thisMonth: number, lastMonth: number): number {
  if (!lastMonth || lastMonth <= 0) return 0;
  return ((thisMonth - lastMonth) / lastMonth) * 100;
}

/** Days in the month `monthOffset` away from `now` (0 = current, -1 = previous). `now` local. */
export function daysInMonth(now: Date, monthOffset = 0): number {
  return new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0).getDate();
}

/**
 * Month-over-month change on a PER-DAY (run-rate) basis, signed.
 * Compares this month's average daily spend (MTD ÷ days elapsed) against last month's average
 * daily spend (full total ÷ days in that month). This fixes the bug where a PARTIAL current month
 * (month-to-date) was compared against a FULL previous month, producing a bogus large drop
 * (e.g. on the 17th, ~17/31 of the month read as ≈-45%). At equal daily run-rates this returns ~0.
 * `now` injected for determinism. Returns 0 when there is no baseline.
 * NB: the current day is still accumulating in AWS Cost Explorer, so the latest day's spend is
 * partial — a small downward bias in this-month's daily average (far smaller than the partial-vs-full
 * bug this replaces). A same-day-range MTD comparison would remove it but needs a prev-month query.
 */
export function momChangePctDaily(thisMtd: number, lastMonthTotal: number, now: Date): number {
  const elapsed = now.getDate();          // days elapsed in the current month (MTD)
  const lastDays = daysInMonth(now, -1);  // full days in the previous calendar month
  if (elapsed <= 0 || lastDays <= 0) return 0;
  return momChangePct(thisMtd / elapsed, lastMonthTotal / lastDays);
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
