import { describe, it, expect } from 'vitest';
import { momChangePct, momChangePctDaily, daysInMonth, projectMonthEnd, trendPill } from './cost';

describe('momChangePct', () => {
  it('computes a positive change', () => {
    expect(momChangePct(120, 100)).toBeCloseTo(20);
  });
  it('computes a negative change', () => {
    expect(momChangePct(80, 100)).toBeCloseTo(-20);
  });
  it('returns 0 when last month is 0 or missing (no baseline)', () => {
    expect(momChangePct(100, 0)).toBe(0);
    expect(momChangePct(100, NaN)).toBe(0);
  });
});

describe('daysInMonth', () => {
  it('returns days in the previous calendar month', () => {
    expect(daysInMonth(new Date(2026, 5, 17), -1)).toBe(31);   // June → May = 31
    expect(daysInMonth(new Date(2024, 2, 1), -1)).toBe(29);    // March 2024 → Feb (leap) = 29
    expect(daysInMonth(new Date(2026, 2, 1), -1)).toBe(28);    // March 2026 → Feb = 28
  });
  it('returns days in the current month at offset 0', () => {
    expect(daysInMonth(new Date(2026, 5, 17), 0)).toBe(30);    // June = 30
  });
});

describe('momChangePctDaily (per-day run-rate — the MoM fix)', () => {
  // June 17 (day 17), previous month May has 31 days.
  it('equal daily run-rate ⇒ ~0 even though the month is partial (the bug fix)', () => {
    // MTD 170 over 17 days = $10/day; May 310 over 31 days = $10/day → 0%.
    expect(momChangePctDaily(170, 310, new Date(2026, 5, 17))).toBeCloseTo(0);
    // the OLD partial-vs-full math would have shown a bogus large negative:
    expect(momChangePct(170, 310)).toBeLessThan(-40);
  });
  it('higher daily run-rate ⇒ positive', () => {
    expect(momChangePctDaily(204, 310, new Date(2026, 5, 17))).toBeCloseTo(20);  // $12/day vs $10/day
  });
  it('lower daily run-rate ⇒ negative', () => {
    expect(momChangePctDaily(136, 310, new Date(2026, 5, 17))).toBeCloseTo(-20); // $8/day vs $10/day
  });
  it('returns 0 with no baseline (last month 0)', () => {
    expect(momChangePctDaily(100, 0, new Date(2026, 5, 17))).toBe(0);
  });
});

describe('projectMonthEnd', () => {
  it('extrapolates linearly mid-month', () => {
    // June 10: 30-day month, day 10, mtd 100 → 300
    expect(projectMonthEnd(100, new Date(2026, 5, 10))).toBeCloseTo(300);
  });
  it('equals mtd on the last day of the month', () => {
    expect(projectMonthEnd(300, new Date(2026, 5, 30))).toBeCloseTo(300); // June has 30 days
  });
  it('uses 29 days for a leap February', () => {
    // Feb 1, 2024 (leap), mtd 10 → (10/1)*29 = 290
    expect(projectMonthEnd(10, new Date(2024, 1, 1))).toBeCloseTo(290);
  });
  it('uses 28 days for a non-leap February', () => {
    expect(projectMonthEnd(10, new Date(2026, 1, 1))).toBeCloseTo(280);
  });
});

describe('trendPill', () => {
  it('renders up/down arrows and zero', () => {
    expect(trendPill(4.23)).toBe('↑4.2%');
    expect(trendPill(-2.3)).toBe('↓2.3%');
    expect(trendPill(0)).toBe('0.0%');
  });
});
