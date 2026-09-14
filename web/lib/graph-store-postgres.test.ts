import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { rebuildGraph, rebuildInfraGraph } from './graph-store';
import { readGraphState, writeGraphState } from './graph-state';
const api = vi.hoisted(() => ({ pool: null as unknown }));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'fixture' }) }));
vi.mock('@/lib/db', () => ({ getPool: () => api.pool }));
import { GET } from '../app/api/graph/route';

// Opt-in, disposable PG17 server only. The Unix socket is mounted in a private task directory;
// no host port, AWS endpoint, or product dependency is needed.
const socket = process.env.GRAPH_TEST_POSTGRES_SOCKET;
describe.skipIf(!socket)('inventory graph publication on PostgreSQL', () => {
  let pool: Pool;
  const migrations = resolve('../terraform/v2/foundation/migrations');
  const flowTypes = ['route53', 'cloudfront', 'alb', 'nlb', 'target_group', 'waf', 'ec2',
    'lambda', 'ecs_task', 's3', 'subnet', 'apigatewayv2_api', 'apigatewayv2_integration', 'cloudfront_vpc_origin'];
  const now = Date.now();
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - 3_600_000).toISOString();
  beforeAll(async () => {
    const admin = new Pool({ host: socket, user: 'postgres', database: 'awsops' });
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='awsops_graph_task3'")).rowCount)
      await admin.query('CREATE DATABASE awsops_graph_task3');
    await admin.end();
    pool = new Pool({ host: socket, user: 'postgres', database: 'awsops_graph_task3' });
    api.pool = pool;
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE SCHEMA IF NOT EXISTS sql_reader;
      DO $$ BEGIN CREATE ROLE awsops_web; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_worker; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_sql_reader LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    const schema = readFileSync(resolve('../terraform/v2/foundation/data/schema.sql'), 'utf8');
    for (const table of ['inventory_resources', 'inventory_sync_runs'])
      await pool.query(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
    for (const suffix of ['_topology_graph.sql', '_topology_class.sql', '_inventory_sync_freshness.sql',
      '_inventory_sync_unknown_attrs.sql', '_topology_graph_collection_state.sql'])
      await pool.query(readFileSync(resolve(migrations, readdirSync(migrations).find(f => f.endsWith(suffix))!), 'utf8'));
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    api.pool = pool;
    await pool.query(`TRUNCATE inventory_resources, inventory_sync_runs, topology_nodes, topology_edges, topology_graph_state;
      DROP TRIGGER IF EXISTS reject_publication ON topology_nodes;`);
    await pool.query(`INSERT INTO inventory_sync_runs
      (resource_type, status, started_at, finished_at, last_success_at, row_count, unknown_attribute_count)
      SELECT t, 'succeeded', $2, $2, $2, 0, 0 FROM unnest($1::text[]) t`, [flowTypes, recent]);
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool?.end(); });
  async function seed(cls: string, captured = recent, account = 'self') {
    const type = cls === 'flow' ? 'alb' : 'vpc';
    await pool.query(`INSERT INTO inventory_resources(resource_type, account_id, resource_id, data, captured_at)
      VALUES ($1,$2,'one','{"arn":"arn:alb","dns_name":"web.example.test"}',$3)`, [type, account, captured]);
    await pool.query(`INSERT INTO inventory_sync_runs(resource_type,status,started_at,finished_at,last_success_at,row_count,unknown_attribute_count)
      VALUES ($1,'succeeded',$2,$2,$2,1,0) ON CONFLICT(resource_type,account_id)
      DO UPDATE SET row_count=1`, [type, recent]);
  }
  const build = (cls: string) => cls === 'flow' ? rebuildGraph(pool) : rebuildInfraGraph(pool);
  const state = (cls: string, account = 'self') => readGraphState(pool, account, cls as never);

  it.each(['flow', 'infra'])('%s does not renew stale source data with a fresh publication', async cls => {
    await seed(cls, old);
    expect((await build(cls)).nodes).toBeGreaterThan(0);
    const result = await state(cls);
    expect(result).toMatchObject({ status: 'ok', stale: true });
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceId: `inventory:${cls === 'flow' ? 'alb' : 'vpc'}`, capturedAtMs: Date.parse(old),
      lastSuccessAtMs: Date.parse(recent), scope: 'aggregate',
    })]));
  });
  it.each(['flow', 'infra'])('%s retains graph and original publication evidence after collection failure', async cls => {
    await seed(cls);
    await build(cls);
    const previous = await state(cls);
    await pool.query(`DELETE FROM inventory_resources;
      UPDATE inventory_sync_runs SET status='failed', finished_at=now();`);
    await build(cls);
    const result = await state(cls);
    expect(result).toMatchObject({ status: 'error', stale: true, retainedPrevious: true,
      captured_at: previous.captured_at, publishedSources: previous.publishedSources });
    expect((await pool.query('SELECT count(*)::int AS n FROM topology_nodes WHERE class=$1', [cls])).rows[0].n).toBeGreaterThan(0);
  });
  it('retains a vanished host infra source until explicit successful-empty evidence arrives', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await pool.query('DELETE FROM inventory_sync_runs');
    await pool.query(`INSERT INTO inventory_resources(resource_type, resource_id, data, captured_at) VALUES
      ('vpc','vpc-kept','{}',$1), ('subnet','subnet-lost','{"vpc_id":"vpc-kept"}',$1)`, [recent]);
    await pool.query(`INSERT INTO inventory_sync_runs
      (resource_type, status, started_at, finished_at, last_success_at, row_count, unknown_attribute_count)
      SELECT t, 'succeeded', $1, $1, $1, 1, 0 FROM unnest(ARRAY['vpc','subnet']) t`, [recent]);
    await build('infra');
    const previous = await state('infra');
    const nodes = (await pool.query("SELECT * FROM topology_nodes WHERE account_id='self' AND class='infra' ORDER BY id")).rows;
    expect(nodes.map(node => node.id)).toEqual(['subnet:subnet-lost', 'vpc:vpc-kept']);
    expect(previous).toMatchObject({ status: 'ok', stale: false, retainedPrevious: false });
    expect(previous.publishedSources).toHaveLength(2);

    await pool.query(`DELETE FROM inventory_resources WHERE resource_type='subnet';
      DELETE FROM inventory_sync_runs WHERE resource_type='subnet';`);
    for (const offset of [1_000, 2_000]) {
      clock.mockReturnValue(now + offset);
      await build('infra');
      expect((await pool.query("SELECT * FROM topology_nodes WHERE account_id='self' AND class='infra' ORDER BY id")).rows).toEqual(nodes);
      const result = await state('infra');
      expect(result).toMatchObject({ status: 'unavailable', stale: true, retainedPrevious: true,
        captured_at: previous.captured_at, publishedSources: previous.publishedSources });
      expect(new Date(result.attempted_at).getTime()).toBe(now + offset);
      expect(result.sources).toContainEqual(expect.objectContaining({
        sourceId: 'inventory:subnet', status: 'unavailable', producerStatus: 'unknown', reasons: ['missing_ledger'],
      }));
    }

    await pool.query(`INSERT INTO inventory_sync_runs
      (resource_type, status, started_at, finished_at, last_success_at, row_count, unknown_attribute_count)
      VALUES ('subnet', 'succeeded', $1, $1, $1, 0, 0)`, [recent]);
    clock.mockReturnValue(now + 3_000);
    await build('infra');
    const confirmed = await state('infra');
    expect(confirmed).toMatchObject({ status: 'ok', stale: false, retainedPrevious: false });
    expect(new Date(confirmed.captured_at).getTime()).toBeGreaterThan(new Date(previous.captured_at).getTime());
    expect(confirmed.publishedSources).toContainEqual(expect.objectContaining({
      sourceId: 'inventory:subnet', status: 'empty', producerStatus: 'succeeded', itemCount: 0, reasons: [],
    }));
    expect((await pool.query("SELECT id FROM topology_nodes WHERE account_id='self' AND class='infra' ORDER BY id")).rows)
      .toEqual([{ id: 'vpc:vpc-kept' }]);
  });
  it.each(['flow', 'infra'])('%s publishes a confirmed successful zero and sweeps the old graph', async cls => {
    await seed(cls);
    await build(cls);
    await pool.query(`DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET row_count=0;`);
    await build(cls);
    expect(await state(cls)).toMatchObject({ status: 'empty', stale: false, retainedPrevious: false });
    expect((await pool.query('SELECT * FROM topology_nodes WHERE class=$1', [cls])).rows).toEqual([]);
  });
  it.each([1, null])('missing rows with producer count %s are not a confirmed successful zero', async count => {
    await seed('infra');
    await build('infra');
    await pool.query('DELETE FROM inventory_resources');
    await pool.query("UPDATE inventory_sync_runs SET row_count=$1 WHERE resource_type='vpc'", [count]);
    await build('infra');
    expect(await state('infra')).toMatchObject({ status: 'partial', stale: true, retainedPrevious: true });
    expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBeGreaterThan(0);
  });
  it.each(['partial', 'running', 'missing', 'unknown_attributes'])('does not sweep an empty %s collection', async mode => {
    await seed('infra');
    await build('infra');
    await pool.query('DELETE FROM inventory_resources');
    if (mode === 'missing') await pool.query('DELETE FROM inventory_sync_runs');
    else if (mode === 'unknown_attributes') await pool.query('UPDATE inventory_sync_runs SET unknown_attribute_count=NULL');
    else await pool.query('UPDATE inventory_sync_runs SET status=$1', [mode]);
    await build('infra');
    expect(await state('infra')).toMatchObject({ stale: true, retainedPrevious: true });
    expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBeGreaterThan(0);
  });
  it('keeps unknown capture/ledger distinct from successful empty', async () => {
    await pool.query('DELETE FROM inventory_sync_runs');
    await build('flow');
    expect(await state('flow')).toMatchObject({ status: 'unavailable', stale: true });
    expect(await state('infra')).toMatchObject({ status: 'unknown', stale: true });
  });
  it('does not use fresh inventory to certify an old graph', async () => {
    await seed('infra');
    await build('infra');
    await pool.query(`UPDATE topology_graph_state SET captured_at=$1`, [old]);
    expect(await state('infra')).toMatchObject({ stale: true });
  });
  it('retains publication and records a failed write without leaking provider errors', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    await pool.query(`CREATE OR REPLACE FUNCTION reject_graph() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'credential=do-not-expose'; END $$;
      CREATE TRIGGER reject_publication BEFORE INSERT OR UPDATE ON topology_nodes
      FOR EACH ROW EXECUTE FUNCTION reject_graph();`);
    await expect(build('infra')).rejects.toThrow();
    expect(await state('infra')).toMatchObject({ status: 'error', retainedPrevious: true,
      captured_at: previous.captured_at, publishedSources: previous.publishedSources });
    expect(JSON.stringify(await state('infra'))).not.toContain('credential');
  });
  it('older and equal attempts cannot replace graph or state', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(old));
    await pool.query(`DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET row_count=0`);
    await build('infra');
    vi.restoreAllMocks();
    expect(await state('infra')).toEqual(previous);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x696e6672]);
      expect(await writeGraphState(client, 'self', {
        status: 'error', publish: false, attemptedAt: new Date(previous.attempted_at).toISOString(), details: {},
      }, 'infra' as never)).toBe(false);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBeGreaterThan(0);
  });
  it('aggregate API scope is unknown; a vanished member keeps its own last-good graph', async () => {
    await seed('infra', recent, '111122223333');
    await build('infra');
    expect(await state('infra', '__all__')).toMatchObject({ status: 'unknown', stale: true, coverage: 'unknown' });
    await pool.query(`DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET status='failed'`);
    await build('infra');
    expect(await state('infra', '111122223333')).toMatchObject({ status: 'error', retainedPrevious: true });
  });
  it('processes a ledger-only member success and sweeps its previous graph', async () => {
    await pool.query(`INSERT INTO topology_nodes(account_id,id,kind,label,run_id,class)
      VALUES ('111122223333','vpc:gone','vpc','gone','old','infra');
      INSERT INTO inventory_sync_runs(resource_type,account_id,status,started_at,finished_at,last_success_at,row_count,unknown_attribute_count)
      VALUES ('vpc','111122223333','succeeded',now(),now(),now(),0,0),
             ('vpc','444455556666','succeeded',now(),now(),now(),0,0);`);
    await build('infra');
    for (const account of ['111122223333', '444455556666']) {
      expect(await state('infra', account)).toMatchObject({ status: 'empty', stale: false });
      expect((await pool.query('SELECT * FROM topology_nodes WHERE account_id=$1', [account])).rows).toEqual([]);
    }
  });
  it('does not infer member successful absence from the host aggregate ledger', async () => {
    await seed('infra', recent, '111122223333');
    await build('infra');
    await pool.query('DELETE FROM inventory_resources');
    await build('infra');
    expect(await state('infra', '111122223333')).toMatchObject({ stale: true, retainedPrevious: true });
    expect((await pool.query("SELECT * FROM topology_nodes WHERE account_id='111122223333'")).rowCount).toBeGreaterThan(0);
  });
  it('retains the graph and reports a source-read failure during ledger schema rollout', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    await pool.query('ALTER TABLE inventory_sync_runs RENAME TO inventory_sync_runs_unavailable');
    try {
      await expect(build('infra')).rejects.toThrow();
      expect(await state('infra')).toMatchObject({ status: 'error', stale: true, retainedPrevious: true,
        failureReason: 'source_read_failed', captured_at: previous.captured_at });
      expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBeGreaterThan(0);
    } finally { await pool.query('ALTER TABLE inventory_sync_runs_unavailable RENAME TO inventory_sync_runs'); }
  });
  it('API nodes and state stay on one snapshot across a concurrent publication', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    api.pool = { connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      return { release: () => client.release(), query: async (sql: string, args?: unknown[]) => {
        const result = await query(sql, args);
        if (sql.includes('FROM topology_graph_state')) {
          await pool.query('DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET row_count=0');
          await build('infra');
        }
        return result;
      } };
    } };
    const body = await (await GET(new Request('http://localhost/api/graph?class=infra'))).json();
    expect(body.collection.captured_at).toBe(new Date(previous.captured_at).toISOString());
    expect(body.nodes.length).toBeGreaterThan(0);
    expect((await pool.query('SELECT * FROM topology_nodes')).rows).toEqual([]);
  });
  it('API can read retained nodes before the state migration without an aborted transaction', async () => {
    await seed('infra');
    await build('infra');
    await pool.query('ALTER TABLE topology_graph_state RENAME TO topology_graph_state_unavailable');
    try {
      const response = await GET(new Request('http://localhost/api/graph?class=infra'));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.collection.status).toBe('unknown');
      expect(body.nodes.length).toBeGreaterThan(0);
    } finally { await pool.query('ALTER TABLE topology_graph_state_unavailable RENAME TO topology_graph_state'); }
  });
});
