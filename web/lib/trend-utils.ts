// Home-dashboard trend helpers (gap L127) — pure, unit-tested. Extracted from app/page.tsx
// (Next.js pages may not export extra symbols).

export interface TrendPointLike { date: string; total?: number | string; [k: string]: unknown }

/** Nearest snapshot to `daysAgo` within ±2 CALENDAR days (v1 tolerance): the target is
 *  date-normalized so gaps are integral — comparing against a time-of-day-bearing now() made
 *  the window asymmetric and wall-clock-dependent. Shared by the delta table and the KPI bar. */
export function nearestSnapshot<T extends TrendPointLike>(pts: T[], daysAgo: number): T | null {
  const target = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  let best: T | null = null;
  let bestGap = 3;
  for (const p of pts) {
    const gap = Math.abs((new Date(p.date).getTime() - new Date(target).getTime()) / 86_400_000);
    if (gap < bestGap) { best = p; bestGap = gap; }
  }
  return best;
}

/** 7d(-ish) net change of the fleet total, honest-degrade to null (rendered '—') when the data
 *  cannot support the claim:
 *  - fewer than 2 snapshots, or no baseline within the ±2-calendar-day tolerance;
 *  - the qualifying baseline IS the latest snapshot (a stale-sync self-diff fabricates 0);
 *  - the LATEST snapshot itself is >2 days old (a 2-day-old-vs-9-day-old diff labeled "7d");
 *  - COVERAGE PARITY: the diff sums only the types snapshotted on BOTH days — the snapshot
 *    writer emits one row per type on its own success path, so a mid-fan-out or partially
 *    failed day drops types from `total`, which a raw total-diff would render as a large
 *    confident negative (a sync artifact — worse than a fabricated 0). */
export function netChange(pts: TrendPointLike[], daysAgo: number): number | null {
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  if (nearestSnapshot(pts, 0) !== last) return null; // latest point itself is stale
  const base = nearestSnapshot(pts, daysAgo);
  if (!base || base === last) return null;
  const keys = Object.keys(last).filter(
    (k) => k !== 'date' && k !== 'total' && typeof last[k] === 'number' && typeof base[k] === 'number',
  );
  if (!keys.length) return null;
  const sumOf = (p: TrendPointLike) => keys.reduce((s, k) => s + Number(p[k] ?? 0), 0);
  return sumOf(last) - sumOf(base);
}
