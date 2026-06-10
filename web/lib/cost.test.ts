import { describe, it, expect } from 'vitest';
import { momChangePct, projectMonthEnd, trendPill } from './cost';

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
