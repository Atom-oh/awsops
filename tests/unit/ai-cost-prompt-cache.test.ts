// tests/unit/ai-cost-prompt-cache.test.ts
import { describe, it, expect } from 'vitest';
import { cachedSystem } from '@/lib/ai-cost/prompt-cache';

describe('cachedSystem', () => {
  it('returns the plain string unchanged when caching is disabled', () => {
    expect(cachedSystem('SYS', false)).toBe('SYS');
  });
  it('returns a cache-pointed block array when enabled for a real (long) system prefix', () => {
    const longSys = 'X'.repeat(2500); // above the ~2k-char Bedrock cache floor
    expect(cachedSystem(longSys, true)).toEqual([
      { type: 'text', text: longSys, cache_control: { type: 'ephemeral' } },
    ]);
  });
  it('does not cache a sub-minimum prefix even when enabled (Bedrock would ignore it)', () => {
    expect(cachedSystem('a short prompt', true)).toBe('a short prompt');
  });
});
