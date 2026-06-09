// src/lib/ai-cost/answer-cache.ts
// ADR-033 Phase 1: EXACT-MATCH answer cache (semantic cache is Phase 2 / Aurora pgvector).
// TTL is bounded by the Steampipe 5-min query cache (stdTTL 300) so a cached answer
// can never be staler than the data it summarized. Per-account invalidation lets
// write/mutation events drop an account's answers.
import NodeCache from 'node-cache';
import { createHash } from 'crypto';

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // ≤ Steampipe window
const STOP = new Set(['the', 'a', 'an', '좀', '해줘', '보여줘', 'please']);

export interface CachedAnswer { content: string; via?: string; usedTools?: string[]; }

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ')
    .split(' ').filter(w => !STOP.has(w)).join(' ');
}

export function sourceDataFingerprint(rowsJson: string, pluginVersion: string): string {
  return createHash('sha256').update(`${pluginVersion} ${rowsJson}`).digest('hex').slice(0, 16);
}

export function answerCacheKey(p: { accountId: string; userSub: string; route: string; question: string; fingerprint: string }): string {
  const norm = normalizeQuestion(p.question);
  return `ans:${p.accountId}:${p.userSub}:${p.route}:${p.fingerprint}:${createHash('sha256').update(norm).digest('hex').slice(0, 24)}`;
}

const accountKeys = new Map<string, Set<string>>(); // accountId → keys (for invalidation)

export function getAnswer(key: string): CachedAnswer | undefined {
  return cache.get<CachedAnswer>(key);
}
export function setAnswer(key: string, accountId: string, value: CachedAnswer): void {
  cache.set(key, value);
  if (!accountKeys.has(accountId)) accountKeys.set(accountId, new Set());
  accountKeys.get(accountId)!.add(key);
}
export function invalidateAccount(accountId: string): void {
  const keys = accountKeys.get(accountId);
  if (keys) { keys.forEach((k) => cache.del(k)); keys.clear(); }
}
