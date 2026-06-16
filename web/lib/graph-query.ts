import type { Pool } from 'pg';

// Recursive-CTE traversal over topology_edges (ADR-043 Step 1). Uses the SQL-standard PG 17
// CYCLE clause for cycle safety (no manual visited array) + a hard depth backstop.
export interface GraphReach { id: string; depth: number }

export const MAX_DEPTH = 8;

// down = follow source→target (what this node fronts/leads to);
// up   = follow target→source (what leads to / depends on this node).
export function traversalSql(dir: 'down' | 'up'): string {
  const cur = dir === 'down' ? 'source' : 'target';
  const next = dir === 'down' ? 'target' : 'source';
  return `WITH RECURSIVE walk(node, depth) AS (
            SELECT $1::text, 0
            UNION ALL
            SELECT e.${next}, w.depth + 1
              FROM topology_edges e JOIN walk w ON e.${cur} = w.node
             WHERE e.account_id = 'self' AND w.depth < ${MAX_DEPTH}
          ) CYCLE node SET is_cycle USING path
          SELECT node AS id, min(depth) AS depth
            FROM walk WHERE node <> $1
           GROUP BY node ORDER BY min(depth), node`;
}

export async function downstream(pool: Pool, id: string): Promise<GraphReach[]> {
  const r = await pool.query(traversalSql('down'), [id]);
  return r.rows as GraphReach[];
}
export async function upstream(pool: Pool, id: string): Promise<GraphReach[]> {
  const r = await pool.query(traversalSql('up'), [id]);
  return r.rows as GraphReach[];
}
// Blast radius = everything that depends on this node (reached by following edges backwards).
export const blastRadius = upstream;
