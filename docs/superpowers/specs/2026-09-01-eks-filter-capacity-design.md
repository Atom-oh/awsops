# EKS overview cluster/VPC filter + fleet node capacity bars — 2 gap-audit items (L130, L132)

**Status:** Batch 18, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch18`.
**WA pillar:** Operational Excellence (fleet navigation / capacity visibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L130 (cluster/VPC facet filter on
the EKS overview), L132 (node capacity / system-reserved visualizations on the nodes subpage —
the node-DETAIL stacked bars already exist in `NodeCapacityCards`).

## Decisions

### L130 — EKS overview cluster/VPC filter
- New `EksFilterPanel` (`web/components/eks/`, default export): a collapsible panel above the
  cluster card grid with multi-select **cluster chips** and **VPC chips** (each VPC chip shows
  its cluster count), an **active-filter count badge** on the toggle button, **Clear all**, and
  a **"filtered/total clusters"** counter — v1 parity.
- Semantics: chip selections narrow the cluster CARD GRID and the fleet panels below
  (`visibleRows` by (cluster ∈ selClusters) AND (vpc ∈ selVpcs); empty selection = no
  constraint on that facet). The existing card-click single-cluster scope (`clusterFilter`,
  ring highlight) is preserved and composes on top.
- Clusters without a `vpcId` group under a `(no VPC)` chip rather than disappearing from the
  VPC facet.

### L132 — fleet nodes page capacity bars
- `NodeCapacityCards`'s 3-segment `StackBar` (Requested / Available / System-Reserved) is
  extracted to a **named export** and reused — one source of truth for the segment math.
- New `NodeCapacityList` (`web/components/eks/`, default export), rendered by `FleetKindPage`
  for `kind === 'nodes'` between the KPI row and the table: one row per (filtered) node —
  mono node name + cluster, a CPU stacked bar and a Memory stacked bar, each captioned
  v1-style `avail X | rsv Y`.
- **Requested** comes from a per-cluster `?kind=pods` fetch (the same in-cluster API the pods
  fleet page uses), aggregated per `cluster|node` from the pod rows' scheduler-semantics
  `cpuRequest`/`memRequest`. A cluster whose pods fetch fails degrades honestly: its nodes
  render the Allocatable/Reserved split only with a '요청량 미상' caption — never a fabricated
  zero-requested bar.
- Render cap: 40 nodes with an explicit "N of M shown" truncation note (filter to narrow).

Read-only; no Terraform/IAM/schema changes (both fetches are existing in-cluster GET paths).

## Testing
- EksFilterPanel: chip toggling multi-select, VPC counts, clear-all, badge count,
  filtered/total counter, `(no VPC)` bucket.
- NodeCapacityList: bars + captions from capacity/allocatable/requested; pods-failed cluster →
  '요청량 미상' caption (no requested segment); cap note at >40.
- FleetKindPage: nodes view mounts the capacity list; pods fetch failure for one cluster
  degrades only that cluster's rows.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-18 note; CHANGELOG EN/KO.
