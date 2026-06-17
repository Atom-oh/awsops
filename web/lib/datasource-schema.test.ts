import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
import { upsertSchema, getSchema, listConfiguredSchemas } from './datasource-schema';

beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [] }); });

describe('datasource-schema', () => {
  it('upserts with ON CONFLICT and serialized jsonb', async () => {
    await upsertSchema('acct', 'prometheus', 'prometheus', { metrics: ['up'] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(account_id, slug\)/);
    expect(params[0]).toBe('acct'); expect(params[1]).toBe('prometheus');
    expect(JSON.parse(params[3])).toEqual({ metrics: ['up'] });
  });
  it('rejects an oversized schema with NO query', async () => {
    const huge = { blob: 'x'.repeat(300_000) };
    await expect(upsertSchema('a', 'clickhouse', 'clickhouse', huge)).rejects.toThrow(/size|limit|large/i);
    expect(query).not.toHaveBeenCalled();
  });
  it('getSchema returns the row or null', async () => {
    query.mockResolvedValueOnce({ rows: [{ slug: 'loki', kind: 'loki', schema: { labels: ['app'] }, fetched_at: 't' }] });
    expect((await getSchema('a', 'loki'))!.slug).toBe('loki');
    expect(await getSchema('a', 'none')).toBeNull();
  });
  it('listConfiguredSchemas is account-scoped', async () => {
    await listConfiguredSchemas('acct');
    expect(query.mock.calls[0][1]).toEqual(['acct']);
  });
});
