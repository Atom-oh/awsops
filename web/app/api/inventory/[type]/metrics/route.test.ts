import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const query = vi.fn();
const ec2AvgCpu = vi.fn();
const ec2HourlyCost = vi.fn();
const rdsMetrics = vi.fn();
const rdsInstanceTrends = vi.fn();
const liveResourceTrends = vi.fn();
const hasLiveMetrics = vi.fn();
const liveResourceMetrics = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@/lib/metrics', () => ({
  ec2AvgCpu: (...a: unknown[]) => ec2AvgCpu(...a),
  ec2HourlyCost: (...a: unknown[]) => ec2HourlyCost(...a),
  rdsMetrics: (...a: unknown[]) => rdsMetrics(...a),
  rdsInstanceTrends: (...a: unknown[]) => rdsInstanceTrends(...a),
  liveResourceTrends: (...a: unknown[]) => liveResourceTrends(...a),
  hasLiveMetrics: (...a: unknown[]) => hasLiveMetrics(...a),
  liveResourceMetrics: (...a: unknown[]) => liveResourceMetrics(...a),
}));

const req = (url = 'http://x/api/inventory/ec2/metrics', cookie = 'awsops_token=t') =>
  new Request(url, { headers: { cookie } });
const ctx = (type = 'ec2') => ({ params: { type } });

beforeEach(() => {
  verifyUser.mockReset();
  query.mockReset();
  ec2AvgCpu.mockReset();
  ec2HourlyCost.mockReset();
  rdsMetrics.mockReset();
});

describe('GET /api/inventory/[type]/metrics', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req(), ctx())).status).toBe(401);
  });

  it('ec2 → 2 cards (CPU + cost)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({
      rows: [
        { id: 'i-1', state: 'running', type: 't3.micro' },
        { id: 'i-2', state: 'stopped', type: 't3.micro' },
        { id: 'i-3', state: 'running', type: 't4g.nano' },
      ],
    });
    ec2AvgCpu.mockResolvedValue(15.4);
    ec2HourlyCost.mockResolvedValue(0.03);
    const { GET } = await import('./route');
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const cards = (await res.json()).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0].value).toBe('15.4%');
    expect(cards[1].value).toBe('$0.03');
    // running ids only
    expect(ec2AvgCpu).toHaveBeenCalledWith(['i-1', 'i-3']);
    // counts across all rows
    expect(ec2HourlyCost).toHaveBeenCalledWith({ 't3.micro': 2, 't4g.nano': 1 });
  });

  it('ec2 → em-dash cards when metrics null (degrade)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    ec2AvgCpu.mockResolvedValue(null);
    ec2HourlyCost.mockResolvedValue(null);
    const { GET } = await import('./route');
    const cards = (await (await GET(req(), ctx())).json()).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0].value).toBe('—');
    expect(cards[1].value).toBe('—');
  });

  it('non-ec2/non-rds (s3) → {cards:[]}', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const res = await GET(req(), ctx('s3'));
    expect(res.status).toBe(200);
    expect((await res.json()).cards).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('rds → CPU / connections / free-storage cards', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ id: 'db-1' }, { id: 'db-2' }] });
    rdsMetrics.mockResolvedValue({
      byInstance: {
        'db-1': { cpu: 40, connections: 5, freeStorage: 5_000_000_000, freeableMemory: null, readIops: null, writeIops: null, netIn: null, netOut: null },
        'db-2': { cpu: 60, connections: 7, freeStorage: 8_000_000_000, freeableMemory: null, readIops: null, writeIops: null, netIn: null, netOut: null },
      },
      avgCpu: 50,
    });
    const { GET } = await import('./route');
    const res = await GET(req(), ctx('rds'));
    expect(res.status).toBe(200);
    const cards = (await res.json()).cards as { label: string; value: string | number }[];
    expect(rdsMetrics).toHaveBeenCalledWith(['db-1', 'db-2']);
    expect(cards[0].value).toBe('50%'); // avg CPU
    expect(cards.find((c) => c.label.includes('커넥션'))?.value).toBe(12); // 5 + 7
    expect(cards.find((c) => c.label.includes('스토리지'))?.value).toBe('5GB'); // min(5, 8) GB
  });

  it('rds → em-dash cards when metrics null (degrade)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    rdsMetrics.mockResolvedValue({ byInstance: {}, avgCpu: null });
    const { GET } = await import('./route');
    const cards = (await (await GET(req(), ctx('rds'))).json()).cards as { value: string | number }[];
    expect(cards[0].value).toBe('—');
  });

  it('rds ?id=<db> → single-instance 8-metric object (no fleet query)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    rdsMetrics.mockResolvedValue({
      byInstance: { 'db-1': { cpu: 33, connections: 4, freeStorage: 9_000_000_000, freeableMemory: 2_000_000_000, readIops: 1, writeIops: 2, netIn: 10, netOut: 20 } },
      avgCpu: 33,
    });
    const { GET } = await import('./route');
    const r = new Request('http://x/api/inventory/rds/metrics?id=db-1', { headers: { cookie: 'awsops_token=t' } });
    const body = await (await GET(r, ctx('rds'))).json();
    expect(rdsMetrics).toHaveBeenCalledWith(['db-1']);
    expect(body.instance.cpu).toBe(33);
    expect(body.instance.connections).toBe(4);
    expect(query).not.toHaveBeenCalled(); // per-instance path skips the fleet inventory query
  });

  it('degrades to {cards:[]} on error (never blanks page)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('aurora down'));
    const { GET } = await import('./route');
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).cards).toEqual([]);
  });

  describe('scope query params (match the main table\'s region scope)', () => {
    it('ec2: regions=ap-northeast-2 → region = ANY($n) in the fleet query', async () => {
      verifyUser.mockResolvedValue({ sub: 'u' });
      query.mockResolvedValue({ rows: [] });
      ec2AvgCpu.mockResolvedValue(null);
      ec2HourlyCost.mockResolvedValue(null);
      const { GET } = await import('./route');
      await GET(req('http://x/api/inventory/ec2/metrics?regions=ap-northeast-2'), ctx());
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/region = ANY/);
      expect(params).toContainEqual(['ap-northeast-2', 'global']);
    });

    it('rds: includeGlobal=0 → region <> \'global\' in the fleet query', async () => {
      verifyUser.mockResolvedValue({ sub: 'u' });
      query.mockResolvedValue({ rows: [] });
      rdsMetrics.mockResolvedValue({ byInstance: {}, avgCpu: null });
      const { GET } = await import('./route');
      await GET(req('http://x/api/inventory/rds/metrics?includeGlobal=0'), ctx('rds'));
      const [sql] = query.mock.calls[0];
      expect(sql).toMatch(/region <> 'global'/);
    });

    it('rds ?id=<db> single-instance path ignores scope params (no fleet query to scope)', async () => {
      verifyUser.mockResolvedValue({ sub: 'u' });
      rdsMetrics.mockResolvedValue({ byInstance: { 'db-1': { cpu: 1, connections: 1, freeStorage: 1, freeableMemory: 1, readIops: 1, writeIops: 1, netIn: 1, netOut: 1 } }, avgCpu: 1 });
      const { GET } = await import('./route');
      await GET(req('http://x/api/inventory/rds/metrics?id=db-1&regions=us-east-1'), ctx('rds'));
      expect(query).not.toHaveBeenCalled();
    });
  });
});

describe('rds ?id= trends=1 (gap L141/L142/L155)', () => {
  it('default ?id= shape stays untouched (no trends field, no trends call)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    rdsMetrics.mockResolvedValue({ byInstance: { 'db-1': { cpu: 42 } }, avgCpu: 42 });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/inventory/rds/metrics?id=db-1'), ctx('rds'));
    const body = await res.json();
    expect(body.instance).toMatchObject({ cpu: 42 });
    expect(body).not.toHaveProperty('trends');
    expect(rdsInstanceTrends).not.toHaveBeenCalled();
  });
  it('trends=1 returns ONLY the trends — no redundant rdsMetrics snapshot call', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    rdsInstanceTrends.mockResolvedValue({ spark: {}, mem24h: null, cpu14d: null });
    const { GET } = await import('./route');
    const body = await (await GET(req('http://x/api/inventory/rds/metrics?id=db-1&trends=1'), ctx('rds'))).json();
    expect(body.trends).toEqual({ spark: {}, mem24h: null, cpu14d: null });
    expect(body).not.toHaveProperty('instance');
    expect(rdsInstanceTrends).toHaveBeenCalledWith('db-1');
    expect(rdsMetrics).not.toHaveBeenCalled(); // the section discards the snapshot; its sibling already fetches it
  });
  it('400 on a malformed id (matching the sibling ?ids= charset)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    expect((await GET(req("http://x/api/inventory/rds/metrics?id=db-1'--"), ctx('rds'))).status).toBe(400);
    expect(rdsMetrics).not.toHaveBeenCalled();
  });
});

describe('live-metrics ?id= trends=1 (gap L118)', () => {
  it('trends=1 returns ONLY the 1h series from liveResourceTrends', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    hasLiveMetrics.mockReturnValue(true);
    liveResourceTrends.mockResolvedValue([{ label: 'CPU', fmt: 'pct', samples: null }]);
    const { GET } = await import('./route');
    const body = await (await GET(req('http://x/api/inventory/elasticache/metrics?id=cc-1&trends=1'), ctx('elasticache'))).json();
    expect(body.trends).toEqual([{ label: 'CPU', fmt: 'pct', samples: null }]);
    expect(liveResourceMetrics).not.toHaveBeenCalled();
    expect(liveResourceTrends).toHaveBeenCalledWith('elasticache', 'cc-1');
  });
  it('400 on a malformed live-metrics id', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    hasLiveMetrics.mockReturnValue(true);
    const { GET } = await import('./route');
    expect((await GET(req("http://x/api/inventory/elasticache/metrics?id=x'--"), ctx('elasticache'))).status).toBe(400);
  });
});
