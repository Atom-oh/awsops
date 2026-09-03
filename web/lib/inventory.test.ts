import { describe, it, expect, vi, beforeEach } from 'vitest';
const query = vi.fn();
const lambdaSend = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = lambdaSend; },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
beforeEach(() => { query.mockReset(); lambdaSend.mockReset(); process.env.INV_SYNC_FUNCTION = 'fn'; });

describe('readResources', () => {
  it('returns rows + run status', async () => {
    query.mockResolvedValueOnce({ rows: [{ resource_id: 'i-1', data: { instance_type: 't3.micro' }, captured_at: 't' }] })
         .mockResolvedValueOnce({ rows: [{ status: 'succeeded', finished_at: 't', row_count: 1 }] });
    const { readResources } = await import('./inventory');
    const out = await readResources('ec2', { limit: 50, offset: 0 });
    expect(out.rows[0].resource_id).toBe('i-1');
    expect(out.run.status).toBe('succeeded');
  });

  it('__all__ regions (default) → no region predicate in the WHERE clause', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0 });
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/region\s*=|region\s*<>/i);
  });

  it('explicit regions → region = ANY($n) with includeGlobal folded into the array', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: ['ap-northeast-2', 'us-east-1'], includeGlobal: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/region = ANY/);
    expect(params).toContainEqual(['ap-northeast-2', 'us-east-1', 'global']);
  });

  it('includeGlobal=false with explicit regions → global excluded from the array', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: ['ap-northeast-2'], includeGlobal: false });
    const [, params] = query.mock.calls[0];
    expect(params).toContainEqual(['ap-northeast-2']);
  });

  it('includeGlobal=false with __all__ regions → excludes region=global directly', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: '__all__', includeGlobal: false });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/region <> 'global'/);
  });

  it('empty region selection → guarded to a non-matching sentinel, not an unfiltered query', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: [], includeGlobal: false });
    const [, params] = query.mock.calls[0];
    expect(params).toContainEqual(['__none__']);
  });

  it('includeGlobal=false strips a caller-supplied "global" out of explicit regions', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: ['ap-northeast-2', 'global'], includeGlobal: false });
    const [, params] = query.mock.calls[0];
    expect(params).toContainEqual(['ap-northeast-2']);
  });
});
describe('triggerSync', () => {
  it('queues the sync Lambda asynchronously through the bounded path', async () => {
    lambdaSend.mockResolvedValue({ StatusCode: 202 });
    const { triggerSync } = await import('./inventory');
    await expect(triggerSync('ec2')).resolves.toEqual({ status: 'queued' });
    const command = lambdaSend.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      FunctionName: 'fn',
      InvocationType: 'Event',
    });
  });

  it('rejects an unexpected async invoke status', async () => {
    lambdaSend.mockResolvedValue({ StatusCode: 200 });
    const { triggerSync } = await import('./inventory');
    await expect(triggerSync('ec2')).rejects.toThrow('inventory sync enqueue failed');
  });
});

describe('readAggregates (gap L102 — full-fleet server-side aggregates)', () => {
  it('runs a total + one GROUP BY per distinct spec key with the SAME scoped WHERE', async () => {
    const { readAggregates } = await import('./inventory');
    // total, then GROUP BYs (ec2: stateKey=instance_state, distKey=instance_type,
    // distKey2=instance_state dedupes with stateKey, + filterKeys)
    query.mockResolvedValue({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ n: 1234 }] });
    const out = await readAggregates('ec2', { regions: ['ap-northeast-2'], accounts: '__all__' });
    expect(out.total).toBe(1234);
    const totalSql = String(query.mock.calls[0][0]);
    expect(totalSql).toMatch(/count\(\*\)::int/);
    expect(totalSql).toMatch(/resource_type = \$1/);
    expect(totalSql).toMatch(/region = ANY/); // scoped like readResources
    const groupSqls = query.mock.calls.slice(1).map((c) => String(c[0]));
    expect(groupSqls.length).toBeGreaterThan(0);
    for (const g of groupSqls) {
      expect(g).toMatch(/GROUP BY 1 ORDER BY 2 DESC LIMIT 50/);
      expect(g).toMatch(/COALESCE\(NULLIF\(data->>'/); // ''/NULL → (none)
    }
    // distKey2 === stateKey for ec2 → the key set is DEDUPED (no duplicate GROUP BY)
    const keys = groupSqls.map((g) => g.match(/data->>'([a-z0-9_]+)'/)![1]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('instance_state');
    expect(keys).toContain('instance_type');
  });

  it('maps state/dist/dist2/facets from the spec keys and tolerates a missing spec key', async () => {
    const { readAggregates } = await import('./inventory');
    query.mockImplementation(async (sql: string) => {
      if (!/GROUP BY/.test(sql)) return { rows: [{ n: 7 }] }; // the total query (GROUP BYs also contain count(*)::int)
      const k = sql.match(/data->>'([a-z0-9_]+)'/)![1];
      return { rows: [{ name: `${k}-a`, value: 5 }] };
    });
    const out = await readAggregates('ec2', {});
    expect(out.state![0].name).toBe('instance_state-a');
    expect(out.dist![0].name).toBe('instance_type-a');
    expect(out.dist2![0].name).toBe('instance_state-a'); // shared key resolves both
    for (const buckets of Object.values(out.facets)) expect(buckets[0].value).toBe(5);
  });
});
