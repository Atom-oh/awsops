import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
