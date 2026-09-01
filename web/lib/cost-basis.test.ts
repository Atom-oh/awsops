import { describe, it, expect } from 'vitest';
import { ESTIMATE_UNIT_PRICES, estimateDailyCost } from './cost-basis';

describe('cost-basis (gap L217 single price source)', () => {
  it('pins the documented unit prices — the panel and the estimator share these', () => {
    expect(ESTIMATE_UNIT_PRICES.vcpuHour).toBe(0.04656);
    expect(ESTIMATE_UNIT_PRICES.gbHour).toBe(0.00511);
  });
  it('worked example: 0.5 vCPU + 1 GB ≈ $0.68/day', () => {
    const daily = estimateDailyCost(0.5, 1);
    expect(daily).toBeCloseTo(0.5 * 0.04656 * 24 + 1 * 0.00511 * 24, 10);
    expect(daily).toBeGreaterThan(0.67);
    expect(daily).toBeLessThan(0.69);
  });
});
