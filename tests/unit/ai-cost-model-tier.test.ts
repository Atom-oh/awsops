// tests/unit/ai-cost-model-tier.test.ts
import { describe, it, expect } from 'vitest';
import { pickClassifierModel, shouldSkipSynthesis } from '@/lib/ai-cost/model-tier';

describe('pickClassifierModel', () => {
  it('uses haiku when the heuristic was low/medium confidence (cheap second opinion)', () => {
    expect(pickClassifierModel({ routes: ['cost'], confidence: 'low' })).toBe('haiku-4.5');
  });
  it('uses sonnet when there is no heuristic result at all (hardest cases)', () => {
    expect(pickClassifierModel(null)).toBe('sonnet-4.6');
  });
});
describe('shouldSkipSynthesis', () => {
  it('skips synthesis for a single high-confidence route', () => {
    expect(shouldSkipSynthesis(['cost'], 'high')).toBe(true);
  });
  it('does not skip when multiple routes were selected', () => {
    expect(shouldSkipSynthesis(['cost', 'network'], 'high')).toBe(false);
  });
});
