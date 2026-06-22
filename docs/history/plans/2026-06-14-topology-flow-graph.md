# Plan — Topology request-flow graph (Spec 1: front-door)

> **Base branch:** `feat/v2-architecture-design` · **Implement in an isolated git worktree**
> (the main checkout has a concurrent session's uncommitted OpenCost changes — must not be
> disturbed). Spec: `docs/superpowers/specs/2026-06-14-topology-flow-graph-design.md`.
> **Scope = Spec 1 only** (CF→ALB/NLB→TG→raw targets + CF/LB filter). Spec 2 (EKS/ECS backend
> resolution + env→RDS inference) is a separate later plan.

## Problem

`/topology` draws a VPC→Subnet→{EC2,RDS,ALB} containment tree (`lib/topology.ts` /
`buildTopology`) — low-value for ops. Replace it with a request-flow graph:
`CloudFront → ALB/NLB → TargetGroup → raw target (instance|ip|lambda)`, with per-CF / per-LB
entry-point filtering. Only one new data source (`target_group`) is required; CF/ALB/NLB/RDS
are already synced.

## Constraints / conventions (verified)

- Inventory rows are generic `{ resource_id, region, ...payload }` — **no schema migration**;
  new types are added in `scripts/v2/steampipe/sync_lambda.py` (Steampipe→Aurora, Python) +
  registered in `web/lib/inventory-types.ts`. Steampipe sync is `steampipe_enabled`-gated.
- **⚠️ Steampipe jsonb casing (gate-confirmed):** column names are snake_case but **nested
  struct keys are PascalCase** (AWS SDK shape). Evidence: v1 `src/lib/queries/cloudfront.ts`
  uses `default_cache_behavior ->> 'ViewerProtocolPolicy'`; `agent/lambda/datasource_diag_mcp.py`
  reads `TargetHealthDescriptions[].Target.Id` / `.TargetHealth.State`. So the builder must read
  `origins[].DomainName`, `target_health_descriptions[].Target.Id`, `.TargetHealth.State` — NOT
  snake_case. Test fixtures MUST be built from **real Steampipe output shapes**, or tests pass
  while production renders an empty graph.
- **⚠️ ARN-keyed joins:** `alb`/`nlb` `resource_id` is the LB **name** (node id `alb:${name}`),
  but `tg.load_balancer_arns` and `cloudfront.web_acl_id` are **ARNs**. The builder must index
  ALB/NLB/WAF by their payload **`arn`** field to resolve those edges (CF→ALB domain matching
  uses the `dns_name` payload field, which is fine).
- **VPC-Origin CloudFront (severity corrected: MAJOR/known-limitation, NOT critical):** the
  **common case works** — S3 origins and custom origins that point at a public ALB by its DNS name
  match via `origins[].DomainName ↔ alb.dns_name`. The graph is NOT broadly empty. What does NOT
  resolve is **CF → private (VPC-Origin) LB**: there the origin `DomainName` is the **public FQDN**
  (verified in `terraform/v2/foundation/edge.tf`: `origin.domain_name = var.domain_name`), and the
  real link is `origins[].VpcOriginConfig.VpcOriginId` → the `aws_cloudfront_vpc_origin` resource's
  ARN (= the ALB/NLB ARN). We do **not** sync that resource today, and Steampipe table support for
  `aws_cloudfront_vpc_origin` is **unverified**. Handling (proportionate):
  - default: match `origins[].DomainName` against `alb.dns_name` / `nlb.dns_name` (covers normal distros);
  - VPC-Origin / any unmatched origin → render a labeled **"VPC/unresolved origin"** node, never a
    false edge (honest degradation);
  - **CF→private-LB resolution is an optional add** gated on a feasibility check (Task 0b): if
    Steampipe exposes `aws_cloudfront_vpc_origin` (id → endpoint ARN), sync it and resolve
    `VpcOriginConfig.VpcOriginId → ARN → match ALB/NLB by payload arn`. If not available, leave the
    unresolved node and note it for a follow-up. This is **not a blocker** for Spec 1.
- Web is Next.js 14 thin-BFF, root path, `export default`, standalone build; fetch is `/api/*`.
- Graph builders are **pure / React-Flow-independent** (see `lib/topology.ts` style: node dedup,
  no dangling edges). Tests are vitest, no React for pure libs.
- React Flow render is **theme-aware** already (`colorMode` ← `useTheme()`, dark node styles) —
  reuse it; do not re-introduce hardcoded light colors.
- Read-only posture — no IAM/mutation. `target_group` read = `aws_ec2_target_group` (Steampipe).
- **Data availability:** target_group rows appear only after the steampipe sync lambda is
  redeployed and a sync runs (`steampipe_enabled=true`). The graph degrades gracefully (empty TG
  layer) until then — call this out at hand-off; it is an ops/deploy step, not code.

## Guardrails (from the consensus decision gate, 2026-06-14)

- **Observed vs inferred edges:** every edge carries `confidence`; Spec 1 emits only `'observed'`
  (solid). Renderer must key stroke style off `confidence` so Spec 2's `'inferred'` `→RDS` edges
  render dashed/low-confidence with no renderer rewrite.
- **Batch-sync staleness:** surface the inventory sync timestamp; tolerate orphaned targets
  (unresolvable target id → generic node, never drop/throw); cap per-TG targets with an explicit
  "+N more" node (never silently truncate).

## Tasks

### Task 0 — confirm `aws_ec2_target_group` schema (resolves a gate disagreement)
- [ ] Empirically confirm the real columns before coding (gate split: one reviewer said
      `target_health_descriptions` is a hydrated column on `aws_ec2_target_group`, another said
      health needs the separate `aws_ec2_target_group_health` table). Run on the Steampipe
      instance: `steampipe query "select * from aws_ec2_target_group limit 1"` (and
      `\d aws_ec2_target_group`). Record which of `target_health_descriptions` (column) vs
      `aws_ec2_target_group_health` (separate table) actually carries `Target.Id` + health state.
- [ ] Pin the chosen source in Task 1 accordingly. (No commit — investigation only.)

### Task 0b — feasibility check: `aws_cloudfront_vpc_origin` (for CF→private-LB)
- [ ] Check whether the installed Steampipe AWS plugin exposes `aws_cloudfront_vpc_origin`
      (`steampipe query "select * from aws_cloudfront_vpc_origin limit 1"`). If yes, note its
      id→endpoint-ARN columns — this is what resolves a VPC-Origin distribution to its private
      ALB/NLB. If no, CF→private-LB stays an "unresolved origin" node (follow-up, not a blocker).
- [ ] Outcome decides whether Task 3 includes the optional VpcOriginConfig→ARN resolution.
      (No commit — investigation only.)

### Task 1 — `target_group` Steampipe sync query
- [ ] In `scripts/v2/steampipe/sync_lambda.py`, add a `target_group` entry from
      `aws_ec2_target_group`: `target_group_arn` (→ resource_id), `target_group_name`, `region`,
      `account_id`, `target_type`, `vpc_id`, `protocol`, `port`, `load_balancer_arns`, and the
      target-health source confirmed in Task 0 (`target_health_descriptions` column **or** a join
      to `aws_ec2_target_group_health`). Cast nested jsonb `::text` like the existing cloudfront
      entry. Follow the existing query-tuple shape.
- [ ] Commit: `feat(inventory): sync aws_ec2_target_group (TG→LB + target health)`

### Task 2 — register `target_group` inventory type
- [ ] Add `target_group` to `web/lib/inventory-types.ts` (label "Target Group", group =
      Networking, icon) so `/api/inventory/target_group` + nav resolve.
- [ ] Update `web/lib/inventory-types.test.ts` expectations (type count / presence).
- [ ] Verify: `npx vitest run lib/inventory-types.test.ts` green.
- [ ] Commit: `feat(inventory): register target_group type`

### Task 3 — flow-graph builder: nodes + CF→ALB/NLB / CF→WAF edges (TDD)
- [ ] Write `web/lib/flow-topology.test.ts` first, with fixtures in **real Steampipe shape**
      (PascalCase nested keys): CF→ALB edge when `cloudfront.origins[].DomainName` matches
      `alb.dns_name` (exact + case-insensitive); **ALB indexed by payload `arn`**; CF→WAF via
      `cloudfront.web_acl_id` matched against `waf.arn`; **VPC-origin** distribution whose
      `DomainName` is a public FQDN (≠ any `dns_name`) → **standalone "VPC/unresolved origin" node,
      no false edge** by default (VpcOriginConfig→ARN resolution only if Task 0b found
      `aws_cloudfront_vpc_origin`); node dedup.
- [ ] Implement `web/lib/flow-topology.ts`: `FlowKind`, `FlowNode`, `FlowEdge {…, confidence}`,
      `FlowGraph`, `buildFlowGraph(input)`. Read nested keys as **PascalCase** (`DomainName`,
      `VpcOriginConfig`). Index ALB/NLB/WAF by payload `arn`. Edges default `confidence: 'observed'`.
- [ ] Verify: `npx vitest run lib/flow-topology.test.ts` green.
- [ ] Commit: `feat(topology): flow-graph builder — CF→LB/WAF edges`

### Task 4 — builder: ALB/NLB→TG and TG→target fan-out + orphan tolerance (TDD)
- [ ] Extend `flow-topology.test.ts` (real Steampipe shapes): ALB→TG via `tg.load_balancer_arns`
      matched against **ALB payload `arn`**; TG→target one node per target-health entry read as
      **`Target.Id` + `TargetHealth.State`** (PascalCase, per Task 0's confirmed source), carrying
      `target_type` + health in `meta`; TG with empty targets still yields a node (no throw);
      unparseable target id → generic target node; per-TG target cap emits a "+N more" node; no
      dangling edges.
- [ ] Implement the TG/target edges in `buildFlowGraph` (PascalCase nested-key reads).
- [ ] Verify: `npx vitest run lib/flow-topology.test.ts` green.
- [ ] Commit: `feat(topology): flow-graph builder — ALB→TG→target + orphan/cap handling`

### Task 5 — builder: entry-point subtree filter (TDD)
- [ ] Extend test: `filterFromEntry(graph, nodeId)` returns the BFS-reachable subtree over
      outgoing edges (a CF id → its whole downstream; an LB id → ALB→TG→targets); null/absent =
      full graph.
- [ ] Implement `filterFromEntry` in `flow-topology.ts`.
- [ ] Verify: `npx vitest run lib/flow-topology.test.ts` green.
- [ ] Commit: `feat(topology): entry-point subtree filter`

### Task 6 — page: swap to flow graph + theme-aware render + auto-layout (Datadog-style)
- [ ] **Auto-layout (the "appears at once, cleanly arranged" look):** add `@dagrejs/dagre` and a
      pure `web/lib/flow-layout.ts` (`layoutFlow(nodes, edges) → positioned nodes`) using dagre
      `rankdir: 'LR'` (left→right: CF → ALB → TG → target ranks), tuned `ranksep`/`nodesep`.
      Pure + unit-tested (`flow-layout.test.ts`: every node gets x/y; rank order CF<ALB<TG<target).
      Render with React Flow `fitView` so the whole laid-out graph appears at once (no manual COL
      placement, no progressive/animated reveal). Recompute layout when the filtered graph changes.
- [ ] In `web/app/topology/page.tsx`: change `TYPES` to `['cloudfront','alb','nlb','target_group','waf']`;
      build via `buildFlowGraph` → `layoutFlow`; map `FlowNode`→React Flow nodes with per-`FlowKind`
      fill, target nodes colored by health (semantic tokens), and edge stroke keyed off `confidence`
      (solid=observed). Keep existing `colorMode`/`useTheme` dark wiring + DARK_TINT pattern.
      Remove the old VPC/subnet/ec2/rds `buildTopology` fetch+render from the page (leave
      `lib/topology.ts` file in place).
- [ ] Verify: `npm run build` EXIT 0; `npx vitest run` (no regressions).
- [ ] Commit: `feat(topology): request-flow graph with dagre auto-layout (replaces containment tree)`

### Task 7 — page: entry-point filter UI + sync timestamp
- [ ] Add CF + LB dropdowns to the `PageHeader` right slot; selection drives `filterFromEntry`
      over the already-fetched graph (no refetch); "All" = full graph. Show the inventory sync
      timestamp (from the inventory rows / `/api/inventory` meta) near the header.
- [ ] Verify: `npm run build` EXIT 0; `npx vitest run` green.
- [ ] Commit: `feat(topology): CF/LB entry-point filter + sync freshness`

## Out of scope (Spec 2, separate plan)

EKS/ECS workload grouping (TG target IP ↔ pod/ENI matching), `→RDS` env-endpoint inference
(dashed `'inferred'` edges), ECS service/task sync, OTEL service map, listener routing rules.

## Hand-off / ops note

After merge, redeploy the steampipe sync lambda and run a sync (`steampipe_enabled=true`) so
`target_group` rows populate; until then the TG layer is empty (graph still renders CF→ALB).

**IAM check (gate finding):** target-health data triggers `elasticloadbalancing:DescribeTargetHealth`
(+ `DescribeTargetGroups`) on the Steampipe instance role. Read-only, no new mutation — but
confirm the Steampipe role policy permits these, else the health column returns empty (graph
degrades gracefully to targets-without-health, but the cause should be known).
