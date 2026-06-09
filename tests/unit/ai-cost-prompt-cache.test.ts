// tests/unit/ai-cost-prompt-cache.test.ts
import { describe, it, expect } from 'vitest';
import { cachedSystem } from '@/lib/ai-cost/prompt-cache';

describe('cachedSystem', () => {
  it('returns the plain string unchanged when caching is disabled', () => {
    expect(cachedSystem('SYS', false)).toBe('SYS');
  });
  it('returns a cache-pointed block array when enabled', () => {
    expect(cachedSystem('SYS', true)).toEqual([
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
    ]);
  });
  it('does not cache a too-short prefix even when enabled (below min)', () => {
    expect(cachedSystem('hi', true)).toBe('hi');
  });
});
