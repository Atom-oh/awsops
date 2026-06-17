// ADR-043 — topology graph rebuild runner (OFF the BFF, per the thin-BFF mandate).
// Rebuilds BOTH materialized graphs (each reuses its single-source builder — no rule duplication):
//   - flow  (class='flow')  via rebuildGraph      → traffic-flow topology
//   - infra (class='infra') via rebuildInfraGraph → resource-relationship topology (Step 2)
// The two classes are key-distinct (class in the node PK + edge UNIQUE), so each mark-sweeps only
// its own rows.
//
//   Run from a VPC-with-Aurora context (the ECS task or a bastion), with the Aurora env set:
//     cd web && npx tsx ../scripts/v2/graph-rebuild.mjs
//
// The post-inventory-sync AUTO trigger (a 'graph-rebuild' worker job) invokes this same logic.
import { getPool } from '../../web/lib/db.ts';
import { rebuildGraph, rebuildInfraGraph } from '../../web/lib/graph-store.ts';

const pool = getPool();
const flow = await rebuildGraph(pool);
console.log(`[graph-rebuild] flow: ${flow.nodes} nodes, ${flow.edges} edges`);
const infra = await rebuildInfraGraph(pool);
console.log(`[graph-rebuild] infra: ${infra.nodes} nodes, ${infra.edges} edges`);
process.exit(0);
