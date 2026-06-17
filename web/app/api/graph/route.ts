import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { downstream, upstream } from '@/lib/graph-query';

export const dynamic = 'force-dynamic';

// Read-only graph access (ADR-043 Step 1). GET returns the materialized topology graph, or a
// traversal when ?from=<nodeId>&dir=down|up is passed (for the DevOps agent's RCA / blast-radius).
// No rebuild here — rebuild is heavy and runs OFF the BFF (scripts/v2/graph-rebuild.mjs), per the
// thin-BFF mandate.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const dir = url.searchParams.get('dir') === 'up' ? 'up' : 'down';
  const pool = getPool();
  try {
    if (from) {
      const reach = dir === 'up' ? await upstream(pool, from) : await downstream(pool, from);
      return Response.json({ from, dir, reach });
    }
    const [nodes, edges] = await Promise.all([
      pool.query(`SELECT id, kind, label, meta, captured_at FROM topology_nodes WHERE account_id = 'self' ORDER BY kind, id`),
      pool.query(`SELECT source, target, rel, confidence FROM topology_edges WHERE account_id = 'self'`),
    ]);
    return Response.json({ nodes: nodes.rows, edges: edges.rows, captured_at: nodes.rows[0]?.captured_at ?? null });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
