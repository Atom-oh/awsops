// src/lib/ai-cost/token-budget.ts
// ADR-033 Phase 1: in-process per-(account,user) daily token counter.
// LIMITATION (documented in ADR-033): the counter is volatile — a process
// restart resets it; durable budget state moves to v2 Aurora (Phase 2).
export interface BudgetLimits { dailyTokens: number; warnPct: number; overrideEmails: string[]; }
export interface BudgetCheck { allowed: boolean; warn: boolean; remaining: number; }

const spent = new Map<string, number>();
const dayKey = (acc: string, user: string) => `${acc}:${user}:${new Date().toISOString().slice(0, 10)}`;

export function recordSpend(accountId: string, userSub: string, tokens: number): void {
  const k = dayKey(accountId, userSub);
  spent.set(k, (spent.get(k) || 0) + Math.max(0, tokens));
}
// `userSub` is the Cognito `sub` (UUID) used to partition the daily spend Map key.
// `userEmail` is the Cognito email, compared against the on-call override list
// (the rest of the codebase compares email lists against user.email, never user.sub).
export function checkBudget(accountId: string, userSub: string, userEmail: string, limits: BudgetLimits): BudgetCheck {
  if (limits.overrideEmails.includes(userEmail)) return { allowed: true, warn: false, remaining: limits.dailyTokens };
  const used = spent.get(dayKey(accountId, userSub)) || 0;
  const remaining = Math.max(0, limits.dailyTokens - used);
  return { allowed: used < limits.dailyTokens, warn: used >= limits.dailyTokens * limits.warnPct, remaining };
}
// --- ADR-033 Phase 2: cold-start hydrate from durable Aurora state ---
// Pure: the Aurora read is injected so this module keeps zero db/ coupling.
type BudgetReader = (accountId: string, userSub: string, day: string) => Promise<number>;
const hydrated = new Set<string>();

export async function hydrateBudget(accountId: string, userSub: string, read: BudgetReader): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const k = dayKey(accountId, userSub);
  if (hydrated.has(k)) return;          // once per process per (account,user,day)
  hydrated.add(k);
  try {
    const auroraTotal = await read(accountId, userSub, day);
    // max() so a transient/stale read can never LOWER a live in-flight count.
    spent.set(k, Math.max(spent.get(k) || 0, auroraTotal));
  } catch {
    hydrated.delete(k);               // allow a later retry; degrade to in-process behavior
  }
}

export function _reset(): void { spent.clear(); hydrated.clear(); } // test-only
