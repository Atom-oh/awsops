// tests/unit/ai-cost-token-budget-writer.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn();
const isAuroraEnabledMock = vi.fn(() => true);
vi.mock('@/lib/db', () => ({
  isAuroraEnabled: () => isAuroraEnabledMock(),
  getDb: async () => ({ query: mockQuery }),
}));

import { recordSpendToAurora, fireAndForgetSpendToAurora, readBudgetTotalFromAurora } from '@/lib/db/token-budget-writer';
import { getDriftCounters, _resetForTests } from '@/lib/db/drift';

describe('token-budget-writer', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    isAuroraEnabledMock.mockReturnValue(true);
    _resetForTests();
  });

  it('no-ops when Aurora disabled', async () => {
    isAuroraEnabledMock.mockReturnValue(false);
    await recordSpendToAurora('acc', 'u', '2026-06-09', 10, 20);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(getDriftCounters()).toEqual([]);
  });

  it('UPSERTs accumulating tokens with the composite key params', async () => {
    await recordSpendToAurora('acc', 'u', '2026-06-09', 10, 20);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_token_budget/);
    expect(sql).toMatch(/ON CONFLICT \(account_id, user_sub, day\) DO UPDATE/);
    expect(sql).toMatch(/input_tokens = ai_token_budget\.input_tokens \+ EXCLUDED\.input_tokens/);
    expect(params).toEqual(['acc', 'u', '2026-06-09', 10, 20]);
    expect(getDriftCounters()[0]).toMatchObject({ source: 'ai_token_budget', writes: 1, failures: 0 });
  });

  it('records a drift failure and re-throws on error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(recordSpendToAurora('acc', 'u', '2026-06-09', 1, 1)).rejects.toThrow('boom');
    expect(getDriftCounters()[0]).toMatchObject({ source: 'ai_token_budget', writes: 0, failures: 1 });
  });

  it('readBudgetTotalFromAurora returns input+output, 0 when none/disabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1500' }], rowCount: 1 });
    expect(await readBudgetTotalFromAurora('acc', 'u', '2026-06-09')).toBe(1500);
    isAuroraEnabledMock.mockReturnValue(false);
    expect(await readBudgetTotalFromAurora('acc', 'u', '2026-06-09')).toBe(0);
  });

  it('fireAndForgetSpendToAurora returns void and does not throw on failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('x'));
    expect(fireAndForgetSpendToAurora('acc', 'u', '2026-06-09', 1, 1)).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(getDriftCounters()[0].failures).toBe(1);
  });
});
