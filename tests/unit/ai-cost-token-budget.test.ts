// tests/unit/ai-cost-token-budget.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkBudget, recordSpend, hydrateBudget, _reset } from '@/lib/ai-cost/token-budget';

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

describe('hydrateBudget', () => {
  beforeEach(() => _reset());
  it('seeds the in-process Map from the Aurora total so a restart does not reset the cap', async () => {
    await hydrateBudget('acc', 'u', async () => 900);
    // 900 already spent (durable) → only 100 remains; >=80% so warn
    const r = checkBudget('acc', 'u', 'u@x.com', LIMITS);
    expect(r.remaining).toBe(100);
    expect(r.warn).toBe(true);
  });
  it('never lowers an in-flight count (max of existing Map and Aurora)', async () => {
    recordSpend('acc', 'u', 950);            // in-flight, higher than Aurora
    await hydrateBudget('acc', 'u', async () => 200);
    expect(checkBudget('acc', 'u', 'u@x.com', LIMITS).remaining).toBe(50); // 1000-950, not 1000-200
  });
  it('is memoized per (account,user,day) — calls the reader once', async () => {
    const reader = vi.fn(async () => 100);
    await hydrateBudget('acc', 'u', reader);
    await hydrateBudget('acc', 'u', reader);
    expect(reader).toHaveBeenCalledTimes(1);
  });
});
