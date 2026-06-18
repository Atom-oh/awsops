import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
import { upsertSchema, getSchema, listConfiguredSchemas } from './datasource-schema';

beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [] }); });

describe('datasource-schema (keyed by integration_id)', () => {
  it('upserts with ON CONFLICT (account_id, integration_id) and serialized jsonb', async () => {
    await upsertSchema('acct', 7, 'prometheus', { metrics: ['up'] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(account_id, integration_id\)/);
    expect(params[0]).toBe('acct'); expect(params[1]).toBe(7); expect(params[2]).toBe('prometheus');
    expect(JSON.parse(params[3])).toEqual({ metrics: ['up'] });
  });
  it('rejects an oversized schema with NO query', async () => {
    const huge = { blob: 'x'.repeat(300_000) };
    await expect(upsertSchema('a', 1, 'clickhouse', huge)).rejects.toThrow(/size|limit|large/i);
    expect(query).not.toHaveBeenCalled();
  });
  it('getSchema returns the row (by integration_id) or null', async () => {
    query.mockResolvedValueOnce({ rows: [{ integration_id: 9, kind: 'loki', schema: { labels: ['app'] }, fetched_at: 't' }] });
    expect((await getSchema('a', 9))!.integrationId).toBe(9);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getSchema('a', 404)).toBeNull();
  });
  it('listConfiguredSchemas is account-scoped and maps integration_id/kind', async () => {
    query.mockResolvedValueOnce({ rows: [{ integration_id: 3, kind: 'tempo', schema: {}, fetched_at: 't' }] });
    const rows = await listConfiguredSchemas('acct');
    expect(query.mock.calls[0][1]).toEqual(['acct']);
    expect(rows[0]).toMatchObject({ integrationId: 3, kind: 'tempo' });
  });
  it('surfaces the captured server version from schema.version (null when absent/non-string)', async () => {
    query.mockResolvedValueOnce({ rows: [{ integration_id: 5, kind: 'prometheus', schema: { version: '2.48.0', metrics: ['up'] }, fetched_at: 't' }] });
    expect((await getSchema('a', 5))!.version).toBe('2.48.0'); // version-aware DSL input
    query.mockResolvedValueOnce({ rows: [{ integration_id: 6, kind: 'loki', schema: { labels: ['app'] }, fetched_at: 't' }] });
    expect((await getSchema('a', 6))!.version).toBeNull();
  });
});
