import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only external boundaries are mocked: exercise the real list, auth selection, HTTPS
// request construction, normalization, quantity parsing, and name-based metrics join.
const { describeCluster, getClusterAuth } = vi.hoisted(() => ({
  describeCluster: vi.fn(),
  getClusterAuth: vi.fn(),
}));
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = describeCluster; },
  DescribeClusterCommand: class {},
}));
vi.mock('./eks-registry', () => ({ getClusterAuth }));

import { isKind, listInCluster, normalizeNode } from './eks-incluster';
import type { NodeRow } from './eks-resources';

const NODES = '/api/v1/nodes';
const METRICS = '/apis/metrics.k8s.io/v1beta1/nodes';
const NOW = new Date('2026-09-13T12:00:00Z');
const SAMPLE = '2026-09-13T11:59:45Z';
const UNKNOWN_USAGE = { cpuUsage: null, memUsage: null, usageTimestamp: null };
const node = (name: string) => ({
  metadata: { name },
  status: {
    conditions: [{ type: 'Ready', status: 'True' }],
    capacity: { cpu: '4', memory: '8Gi' },
    allocatable: { cpu: '3920m', memory: '7950Mi' },
  },
});
const metric = (name: string, usage: unknown = { cpu: '125000000n', memory: '1573376Ki' }, timestamp: unknown = SAMPLE) => ({
  metadata: { name }, timestamp, window: '15s', usage,
});
type Reply = { status?: number; body?: unknown; raw?: string; error?: Error; hold?: boolean; responseEvent?: 'aborted' | 'close' | 'error' };
let replies: Map<string, Reply>;
let started: https.RequestOptions[];
let release: Map<string, () => void>;
let timeout: Map<string, { ms: number; fire: () => void }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  describeCluster.mockResolvedValue({
    cluster: { endpoint: 'https://cluster.example.test', certificateAuthority: { data: Buffer.from('test-cluster-ca').toString('base64') } },
  });
  getClusterAuth.mockReset().mockResolvedValue({ mode: 'sa-token', token: 'offline-test-token' });
  replies = new Map([
    [NODES, { body: { kind: 'NodeList', items: [node('n1'), node('n2')] } }],
    [METRICS, { body: { kind: 'NodeMetricsList', items: [] } }],
  ]);
  started = [];
  release = new Map();
  timeout = new Map();
  vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, callback: (res: IncomingMessage) => void) => {
    started.push(options);
    const path = options.path!;
    const req = new EventEmitter() as ClientRequest;
    req.setTimeout = (ms, fire) => {
      timeout.set(path, { ms, fire: fire! });
      return req;
    };
    req.destroy = (error) => {
      queueMicrotask(() => req.emit('error', error));
      return req;
    };
    req.end = (() => {
      const reply = replies.get(path);
      const respond = () => {
        if (!reply) { req.emit('error', new Error(`unexpected path: ${path}`)); return; }
        if (reply.error) { req.emit('error', reply.error); return; }
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = reply.status ?? 200;
        callback(res);
        res.emit('data', Buffer.from(reply.raw ?? JSON.stringify(reply.body)));
        if (reply.responseEvent) {
          res.emit(reply.responseEvent, new Error('response interrupted'));
          return;
        }
        res.emit('end');
      };
      release.set(path, respond);
      if (!reply?.hold) queueMicrotask(respond);
      return req;
    }) as ClientRequest['end'];
    return req;
  }) as typeof https.request);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function readNodes(items: unknown[]): Promise<NodeRow[]> {
  replies.set(METRICS, { body: { kind: 'NodeMetricsList', items } });
  return await listInCluster('usage-test-cluster', 'nodes') as NodeRow[];
}

describe('node actual usage', () => {
  it('joins by name, retains node order and allocations, and ignores metrics-only nodes', async () => {
    const rows = await readNodes([
      metric('n2', { cpu: '0', memory: '0' }),
      metric('gone', { cpu: '99', memory: '99Gi' }),
      metric('n1'),
    ]);
    expect(rows.map((row) => row.name)).toEqual(['n1', 'n2']);
    expect(rows[0]).toMatchObject({
      status: 'Ready', cpuCapacity: 4, cpuAllocatable: 3.92,
      memCapacity: 8192, memAllocatable: 7950,
      cpuUsage: 0.125, memUsage: 1536.5, usageTimestamp: SAMPLE,
    });
    expect(rows[1]).toMatchObject({ cpuUsage: 0, memUsage: 0, usageTimestamp: SAMPLE });
  });

  it.each([
    ['125000000n', 0.125], ['125000u', 0.125], ['125m', 0.125],
    ['1001m', 1.001], ['1001u', 0.001001], ['1001n', 0.000001001],
    ['1.25', 1.25], ['1n', 1e-9], ['1u', 1e-6], ['0', 0],
    [0, 0], ['1e-3', 0.001],
  ])('converts CPU %s to %s cores', async (cpu, cores) => {
    const [row] = await readNodes([metric('n1', { cpu, memory: '512Mi' })]);
    expect(row.cpuUsage).toBe(cores);
    expect(row.memUsage).toBe(512);
  });

  it.each([
    ['512Ki', 0.5], ['1.5Mi', 1.5], ['2Gi', 2048],
    ['1048576', 1], ['1048576m', 0.001], ['1M', 0.95367431640625],
    ['1e6', 0.95367431640625], ['0', 0], [0, 0],
  ])('converts memory %s to %s MiB without rounding', async (memory, mib) => {
    const [row] = await readNodes([metric('n1', { cpu: '250m', memory })]);
    expect(row.memUsage).toBe(mib);
    expect(row.cpuUsage).toBe(0.25);
  });

  it.each([
    undefined, null, '', ' ', 'garbage', '-1', '-1m', '-1Mi',
    '12garbage', '1m trailing', 'NaN', 'Infinity', '1e999',
    true, {}, [], ['1'],
  ].map((invalid) => ({ invalid })))('does not turn invalid/missing quantity $invalid into zero usage', async ({ invalid }) => {
    const [cpuInvalid, memoryInvalid] = await readNodes([
      metric('n1', { cpu: invalid, memory: '512Mi' }),
      metric('n2', { cpu: '250m', memory: invalid }),
    ]);
    expect(cpuInvalid).toMatchObject({ cpuUsage: null, memUsage: 512, usageTimestamp: SAMPLE });
    expect(memoryInvalid).toMatchObject({ cpuUsage: 0.25, memUsage: null, usageTimestamp: SAMPLE });
  });

  it('returns nulls for absent per-node metrics and entirely missing usage', async () => {
    const rows = await readNodes([metric('n1', null)]);
    expect(rows[0]).toMatchObject(UNKNOWN_USAGE);
    expect(rows[1]).toMatchObject(UNKNOWN_USAGE);
    expect(normalizeNode(node('n1'))).toMatchObject(UNKNOWN_USAGE);
  });

  it('does not invent a timestamp for samples without one or with no usable measurement', async () => {
    const { timestamp: _timestamp, ...noTimestamp } = metric('n1');
    const rows = await readNodes([noTimestamp, metric('n2', { cpu: '-1', memory: 'bad' })]);
    for (const row of rows) expect(row).toMatchObject(UNKNOWN_USAGE);
  });

  it('skips malformed entries without dropping another node valid sample', async () => {
    const rows = await readNodes([null, [], 'bad', {}, { metadata: null }, metric('n1')]);
    expect(rows[0]).toMatchObject({ cpuUsage: 0.125, memUsage: 1536.5, usageTimestamp: SAMPLE });
    expect(rows[1]).toMatchObject(UNKNOWN_USAGE);
  });

  it.each([
    '2026-09-13T11:54:59.999Z', '2026-09-13T12:01:00.001Z',
    '2027-09-13T12:00:00Z', 'not-a-time', '2026-09-13',
    '2026-09-13T12:00:00', '', null, 1789300800000,
  ])('excludes stale, invalid, or badly future sample %j', async (timestamp) => {
    const [row] = await readNodes([metric('n1', undefined, timestamp)]);
    expect(row).toMatchObject(UNKNOWN_USAGE);
  });

  it.each([
    '2026-09-13T11:55:00Z', '2026-09-13T12:01:00Z',
    '2026-09-13T20:59:45+09:00', '2026-09-13T11:59:45.123456789Z',
  ])('accepts freshness boundaries and preserves original timestamp %s', async (timestamp) => {
    const [row] = await readNodes([metric('n1', undefined, timestamp)]);
    expect(row).toMatchObject({ cpuUsage: 0.125, memUsage: 1536.5, usageTimestamp: timestamp });
  });

  it.each([
    ['2026-03-02T12:00:00Z', '2026-02-30T11:59:45Z'],
    ['2026-09-13T00:00:00Z', '2026-09-12T24:00:00Z'],
  ])('rejects impossible calendar/time values even if Date.parse normalizes them near %s', async (now, timestamp) => {
    vi.setSystemTime(new Date(now));
    const [row] = await readNodes([metric('n1', undefined, timestamp)]);
    expect(row).toMatchObject(UNKNOWN_USAGE);
  });
});

describe('node metrics request isolation', () => {
  it.each(['aborted', 'close', 'error'] as const)('returns nodes with unknown usage after a premature metrics response %s', async (responseEvent) => {
    replies.set(METRICS, { raw: '{"items":[', responseEvent });
    const result = await Promise.race([
      listInCluster('usage-test-cluster', 'nodes'),
      new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
    ]);
    expect(result).not.toBe('pending');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: 'n1', ...UNKNOWN_USAGE });
  });

  it('rejects a premature nodes response instead of returning a successful empty list', async () => {
    replies.set(NODES, { raw: '{"items":[', responseEvent: 'aborted' });
    await expect(listInCluster('usage-test-cluster', 'nodes')).rejects.toThrow('k8s response aborted');
  });

  it('starts the read-only metrics request before the nodes read completes, using the same connection/token', async () => {
    replies.get(NODES)!.hold = true;
    replies.set(METRICS, { body: { items: [metric('n1')] } });
    const result = listInCluster('usage-test-cluster', 'nodes');
    try {
      await vi.waitFor(() => expect(started.map((r) => r.path)).toEqual([NODES, METRICS]));
      expect(getClusterAuth).toHaveBeenCalledTimes(1);
      for (const request of started) {
        expect(request).toMatchObject({
          hostname: 'cluster.example.test', port: 443, method: 'GET',
          headers: { Authorization: 'Bearer offline-test-token', Accept: 'application/json' },
        });
        expect((request.agent as https.Agent).options.ca).toEqual(Buffer.from('test-cluster-ca'));
        expect(timeout.get(request.path!)!.ms).toBe(4000);
      }
    } finally {
      release.get(NODES)?.();
      await result;
    }
    expect((await result)[0]).toMatchObject({ cpuUsage: 0.125, memUsage: 1536.5 });
  });

  it.each<Reply>([
    { status: 403, body: { message: 'forbidden' } },
    { status: 404, body: { message: 'not found' } },
    { status: 503, body: { message: 'unavailable' } },
    { error: new Error('connection reset') },
    { raw: 'not json' }, { body: null }, { body: [] }, { body: {} },
    { body: { items: null } }, { body: { items: {} } }, { body: { items: 'bad' } },
  ])('returns nodes with null usage when the metrics API is unavailable or malformed (%j)', async (reply) => {
    replies.set(METRICS, reply);
    const rows = await listInCluster('usage-test-cluster', 'nodes');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'n1', cpuAllocatable: 3.92, ...UNKNOWN_USAGE });
    expect(rows[1]).toMatchObject({ name: 'n2', ...UNKNOWN_USAGE });
  });

  it('returns the nodes when the optional metrics request times out', async () => {
    replies.get(METRICS)!.hold = true;
    const result = listInCluster('usage-test-cluster', 'nodes');
    await vi.waitFor(() => expect(timeout.has(METRICS)).toBe(true));
    timeout.get(METRICS)!.fire();
    expect(await result).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'n1', ...UNKNOWN_USAGE }),
    ]));
  });

  it('still propagates a failed nodes read', async () => {
    replies.set(NODES, { status: 403, body: { message: 'nodes forbidden' } });
    await expect(listInCluster('usage-test-cluster', 'nodes')).rejects.toThrow('nodes forbidden');
  });

  it('does not request metrics for other kinds or add metrics/arbitrary paths to the allowlist', async () => {
    replies.set('/api/v1/pods', { body: { items: [{ metadata: { name: 'p1' }, status: { phase: 'Running' } }] } });
    const rows = await listInCluster('usage-test-cluster', 'pods');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'p1', status: 'Running', cpuRequest: 0 });
    expect(started.map((r) => r.path)).toEqual(['/api/v1/pods']);
    expect(rows[0]).not.toHaveProperty('cpuUsage');
    for (const kind of ['metrics', 'nodes.metrics.k8s.io', METRICS, 'secrets', 'pods/exec']) {
      expect(isKind(kind)).toBe(false);
    }
  });
});
