// ADR-043 Step 1 — topology graph rebuild runner (OFF the BFF, per the thin-BFF mandate).
// Reuses web/lib/graph-store.rebuildGraph (which reuses flow-topology — no rule duplication).
//
//   Run from VPC-with-Aurora context (the ECS task or a bastion), with the Aurora env set:
//     cd web && npx tsx ../scripts/v2/graph-rebuild.mjs
//
// Production automation (post-inventory-sync trigger via a VPC-resident TS Node Lambda reusing
// graph-store) is a documented FOLLOW-ON, not part of Step 1. Until then the topology_nodes/edges
// tables stay empty and /api/graph returns an empty graph (the UI is unaffected — it still builds
// client-side from inventory).
import { getPool } from '../../web/lib/db.ts';
import { rebuildGraph } from '../../web/lib/graph-store.ts';

const r = await rebuildGraph(getPool());
console.log(`[graph-rebuild] materialized ${r.nodes} nodes, ${r.edges} edges`);
process.exit(0);
