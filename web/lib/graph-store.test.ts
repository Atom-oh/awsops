import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rebuildGraph } from './graph-store';

// ADR-043 Step 1 — Task 1: the topology_graph migration exists and declares the expected shape.
const MIG_DIR = join(process.cwd(), '..', 'terraform', 'v2', 'foundation', 'migrations');

describe('topology_graph migration', () => {
  const file = readdirSync(MIG_DIR).find((f) => f.endsWith('_topology_graph.sql'));
  it('exists', () => { expect(file, 'topology_graph migration present').toBeTruthy(); });

  it('declares topology_nodes + topology_edges with the upsert keys + indexes', () => {
    const sql = readFileSync(join(MIG_DIR, file!), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS topology_nodes/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS topology_edges/);
    expect(sql).toMatch(/PRIMARY KEY \(account_id, id\)/);              // node upsert key
    expect(sql).toMatch(/UNIQUE \(account_id, source, target, rel\)/);  // edge upsert key
    expect(sql).toMatch(/confidence/);                                  // observed|inferred carried
    expect(sql).toMatch(/run_id/);                                      // mark-sweep stamp
    expect(sql).toMatch(/topology_edges_source_idx/);
    expect(sql).toMatch(/topology_edges_target_idx/);
  });
});

// ADR-043 Step 2 — Task 1: the class-namespace migration (flow|infra) on the graph tables.
describe('topology_class migration', () => {
  const file = readdirSync(MIG_DIR).find((f) => f.endsWith('_topology_class.sql'));
  it('exists', () => { expect(file, 'topology_class migration present').toBeTruthy(); });

  it('adds class to both tables and puts class in the node PK + edge UNIQUE', () => {
    const sql = readFileSync(join(MIG_DIR, file!), 'utf8');
    expect(sql).toMatch(/ALTER TABLE topology_nodes ADD COLUMN IF NOT EXISTS class/);
    expect(sql).toMatch(/ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS class/);
    expect(sql).toMatch(/PRIMARY KEY \(account_id, id, class\)/);                   // node sweep is class-correct
    expect(sql).toMatch(/UNIQUE \(account_id, source, target, rel, class\)/);       // edge sweep is class-correct
    expect(sql).toMatch(/topology_edges_class_source_idx/);                         // traversal index
  });
});

function mockPool(invRows: unknown[]) {
  const calls: string[] = [];
  const client = {
    query: vi.fn((sql: string) => { calls.push(String(sql)); return Promise.resolve({ rows: [] }); }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(() => Promise.resolve({ rows: invRows })), // inventory SELECT
    connect: vi.fn(() => Promise.resolve(client)),
  };
  return { pool, client, calls };
}

describe('rebuildGraph', () => {
  const inv = [
    { resource_type: 'alb', resource_id: 'web', region: 'r', data: { arn: 'arn:alb', dns_name: 'x.elb.amazonaws.com' } },
    { resource_type: 'target_group', resource_id: 'arn:tg', region: 'r', data: { target_group_name: 'tg', target_type: 'ip', load_balancer_arns: ['arn:alb'], target_health_descriptions: [{ Target: { Id: '10.0.0.1' }, TargetHealth: { State: 'healthy' } }] } },
  ];

  it('runs one tx: advisory lock → upserts → mark-sweep → commit', async () => {
    const { pool, calls } = mockPool(inv);
    const res = await rebuildGraph(pool as never, 'RUN1');
    expect(calls[0]).toContain('BEGIN');
    expect(calls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(calls.some((s) => s.includes('INSERT INTO topology_nodes') && s.includes('ON CONFLICT'))).toBe(true);
    expect(calls.some((s) => s.includes('INSERT INTO topology_edges') && s.includes('ON CONFLICT'))).toBe(true);
    expect(calls.some((s) => s.includes('DELETE FROM topology_edges') && s.includes('run_id <> $1'))).toBe(true);
    expect(calls.some((s) => s.includes('DELETE FROM topology_nodes') && s.includes('run_id <> $1'))).toBe(true);
    expect(calls.at(-1)).toContain('COMMIT');
    expect(res.nodes).toBeGreaterThan(0);
    expect(res.edges).toBeGreaterThan(0);
  });

  it('preserves the last-good graph on an empty/failed inventory read (NO sweep)', async () => {
    // empty inventory → empty build. Sweeping now would wipe the last-good materialized graph,
    // so rebuildGraph must skip the destructive delete entirely. (consensus gate MAJOR finding)
    const { pool, calls } = mockPool([]);
    const res = await rebuildGraph(pool as never, 'RUN_EMPTY');
    expect(res.nodes).toBe(0);
    expect(res.edges).toBe(0);
    expect(calls.some((s) => s.includes('DELETE FROM topology_edges'))).toBe(false);
    expect(calls.some((s) => s.includes('DELETE FROM topology_nodes'))).toBe(false);
  });

  it('rolls back on a write error and releases the client', async () => {
    const { pool, client } = mockPool(inv);
    client.query.mockImplementation((sql: string) => {
      if (String(sql).includes('INSERT INTO topology_nodes')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });
    await expect(rebuildGraph(pool as never, 'RUN2')).rejects.toThrow('boom');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK'));
    expect(client.release).toHaveBeenCalled();
  });
});
