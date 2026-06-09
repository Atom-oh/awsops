// tests/unit/ai-cost-answer-cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeQuestion, answerCacheKey, sourceDataFingerprint, getAnswer, setAnswer, invalidateAccount } from '@/lib/ai-cost/answer-cache';

describe('normalizeQuestion', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeQuestion('  EC2   List   ')).toBe('ec2 list');
  });
});
describe('answerCacheKey', () => {
  it('is stable for the same inputs and varies by account', () => {
    const a = answerCacheKey({ accountId: 'A', userSub: 'u', route: 'aws-data', question: 'ec2 list', fingerprint: 'fp' });
    const b = answerCacheKey({ accountId: 'A', userSub: 'u', route: 'aws-data', question: 'ec2 list', fingerprint: 'fp' });
    const c = answerCacheKey({ accountId: 'B', userSub: 'u', route: 'aws-data', question: 'ec2 list', fingerprint: 'fp' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
describe('sourceDataFingerprint', () => {
  it('changes when the underlying rows change', () => {
    expect(sourceDataFingerprint('[{"a":1}]', 'v1')).not.toBe(sourceDataFingerprint('[{"a":2}]', 'v1'));
  });
  it('changes when the plugin/schema version changes', () => {
    expect(sourceDataFingerprint('[{"a":1}]', 'v1')).not.toBe(sourceDataFingerprint('[{"a":1}]', 'v2'));
  });
});
describe('get/set/invalidate', () => {
  beforeEach(() => invalidateAccount('A'));
  it('round-trips a value and isolates per account on invalidate', () => {
    const key = answerCacheKey({ accountId: 'A', userSub: 'u', route: 'aws-data', question: 'q', fingerprint: 'fp' });
    setAnswer(key, 'A', { content: 'hi' });
    expect(getAnswer(key)?.content).toBe('hi');
    invalidateAccount('A');
    expect(getAnswer(key)).toBeUndefined();
  });
});
