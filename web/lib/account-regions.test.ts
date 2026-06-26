import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('validateRegion', () => {
  it('accepts AWS regional ids and rejects global/non-region strings', async () => {
    const { validateRegion } = await import('./account-regions');

    expect(validateRegion('ap-northeast-2')).toBe(true);
    expect(validateRegion('us-east-1')).toBe(true);
    expect(validateRegion('global')).toBe(false);
    expect(validateRegion('us-east-1;drop')).toBe(false);
  });
});

describe('account region helpers', () => {
  it('maps enabled regions grouped by account', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { account_id: 'self', region: 'ap-northeast-2', enabled: true },
        { account_id: '210987654321', region: 'us-east-1', enabled: true },
      ],
    });
    const { listAccountRegions } = await import('./account-regions');

    expect(await listAccountRegions()).toEqual([
      { accountId: 'self', region: 'ap-northeast-2', enabled: true },
      { accountId: '210987654321', region: 'us-east-1', enabled: true },
    ]);
  });

  it('upserts enabled account regions', async () => {
    const { upsertAccountRegion } = await import('./account-regions');

    await upsertAccountRegion('210987654321', 'us-east-1');

    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO account_regions');
    expect(query.mock.calls[0][1]).toEqual(['210987654321', 'us-east-1']);
  });

  it('disables account regions without deleting account trust metadata', async () => {
    const { disableAccountRegion } = await import('./account-regions');

    await disableAccountRegion('210987654321', 'us-east-1');

    expect(String(query.mock.calls[0][0])).toContain('UPDATE account_regions');
    expect(query.mock.calls[0][1]).toEqual(['210987654321', 'us-east-1']);
  });
});
