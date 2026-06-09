// tests/unit/ai-cost-token-budget.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { checkBudget, recordSpend, _reset } from '@/lib/ai-cost/token-budget';

const LIMITS = { dailyTokens: 1000, warnPct: 0.8, overrideEmails: ['oncall@x.com'] };

describe('token budget', () => {
  beforeEach(() => _reset());
  it('allows under budget and reports remaining', () => {
    const r = checkBudget('acc', 'u@x.com', LIMITS);
    expect(r.allowed).toBe(true); expect(r.remaining).toBe(1000); expect(r.warn).toBe(false);
  });
  it('warns at >=80% and soft-caps at 100%', () => {
    recordSpend('acc', 'u@x.com', 850);
    expect(checkBudget('acc', 'u@x.com', LIMITS).warn).toBe(true);
    recordSpend('acc', 'u@x.com', 200); // 1050 > 1000
    expect(checkBudget('acc', 'u@x.com', LIMITS).allowed).toBe(false);
  });
  it('on-call override is always allowed', () => {
    recordSpend('acc', 'oncall@x.com', 5000);
    expect(checkBudget('acc', 'oncall@x.com', LIMITS).allowed).toBe(true);
  });
});
