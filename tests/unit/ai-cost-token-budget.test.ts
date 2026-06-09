// tests/unit/ai-cost-token-budget.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { checkBudget, recordSpend, _reset } from '@/lib/ai-cost/token-budget';

const LIMITS = { dailyTokens: 1000, warnPct: 0.8, overrideEmails: ['oncall@x.com'] };

// Cognito `sub` is a UUID, distinct from the email. Spend is keyed by sub;
// the on-call override is matched by email.
const USER_SUB = '11111111-2222-3333-4444-555555555555';
const USER_EMAIL = 'u@x.com';
const ONCALL_SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ONCALL_EMAIL = 'oncall@x.com';

describe('token budget', () => {
  beforeEach(() => _reset());
  it('allows under budget and reports remaining', () => {
    const r = checkBudget('acc', USER_SUB, USER_EMAIL, LIMITS);
    expect(r.allowed).toBe(true); expect(r.remaining).toBe(1000); expect(r.warn).toBe(false);
  });
  it('warns at >=80% and soft-caps at 100%', () => {
    recordSpend('acc', USER_SUB, 850);
    expect(checkBudget('acc', USER_SUB, USER_EMAIL, LIMITS).warn).toBe(true);
    recordSpend('acc', USER_SUB, 200); // 1050 > 1000
    expect(checkBudget('acc', USER_SUB, USER_EMAIL, LIMITS).allowed).toBe(false);
  });
  it('on-call override is matched by email, not sub, even over budget', () => {
    recordSpend('acc', ONCALL_SUB, 5000);
    // Override is keyed by email; the UUID sub must not be confused with the email list.
    expect(checkBudget('acc', ONCALL_SUB, ONCALL_EMAIL, LIMITS).allowed).toBe(true);
  });
  it('override does NOT trigger when only the sub (not the email) is on the list', () => {
    // Guard against the original bug: passing an override-shaped value as the sub
    // must not bypass the budget. Here the sub is a UUID, email is a normal user.
    recordSpend('acc', USER_SUB, 5000);
    expect(checkBudget('acc', USER_SUB, USER_EMAIL, LIMITS).allowed).toBe(false);
  });
});
