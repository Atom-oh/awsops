# Resource tile micro-stat sublines + fleet drill-down verification — 2 gap-audit items (L82, L131)

**Status:** Batch 20, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch20`.
**WA pillar:** Operational Excellence (at-a-glance state decomposition).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L82 (per-tile micro-stat sublines),
L131 (fleet drill-down pages — VERIFIED ALREADY IMPLEMENTED, tick only).

## L131 — verification, not implementation
v1's KPI StatsCards linking to fleet-wide /k8s/{nodes,pods,deployments,services} pages exist in
v2: the EKS overview KPI cards carry `href="/eks/nodes|pods|deployments|services"`
(`web/app/eks/page.tsx`) and each route renders `FleetKindPage` — full-fleet merged tables
across all connected clusters with their own KPI rows, donuts, per-cluster degrade notes, and
(nodes) the drill-down panel + capacity list. Ticked with a verification note; no code change.

## L82 — per-type tile micro-stat sublines
- **Summary route** (`/api/inventory/summary`): the existing single UNION-ALL splits query
  gains 9 aggregates over already-synced JSONB (no new AWS calls, still ONE round trip, same
  degrade-to-zeros contract): `lambda_runtimes` (distinct), `lambda_long_timeout` (>300s),
  `ebs_total_gb` (sum size), `rds_multi_az`, `rds_unencrypted`, `ecr_scan_on_push` (casing
  tolerant like the SG regex), `ecr_immutable`, `s3_versioning_off`, `cloudfront_enabled`.
  `Splits` grows accordingly (route + client interfaces).
- **UI** (`GroupOverviewClient`): a `TYPE_MICRO` map renders a subline (StatTile's `trend`
  prop) per resource-type tile from splits/byType — group-overview surface (the dashboard-home
  StatsCards remain a follow-up; L82 stays partially resolved): ec2 running/stopped, lambda
  runtimes/>300s, ebs GiB/unencrypted, rds Multi-AZ/unencrypted, ecr scan-on-push/immutable, s3
  public/versioning-off, iam_user no-MFA, security_group open-ingress,
  cloudfront enabled, vpc subnets·NAT·TGW (cross-type counts from byType — zero SQL);
  cloudwatch_alarm has no entry (the Monitoring group is a singleton — no /inventory/g page).
  Sublines render only after the summary loads AND only when the splits aggregation
  succeeded (the route returns `splits: null` on failure — never fabricated '0 no MFA'-style
  zeros; secondary parts of a subline zero-fill via `?? 0` only when their sibling key proves
  the aggregation ran). Terms stay the technical English v1 used.

No Terraform/IAM/schema changes.

## Testing
- Route: new split keys mapped from the UNION-ALL rows; SQL carries the new aggregates and
  the REAL \s escapes; splits failure → `splits: null` (never zeros).
- Client: tiles show sublines when splits are present; no subline before load; vpc subline
  composes from byType.
- Full `npm test` + `tsc` + build + pytest; gap-audit: L131 tick + L82 partial note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **ECR regex escape (the gate MAJOR)** — `\s` inside the template literal collapsed to a
  bare `s`, so `ecr_scan_on_push` could never match `jsonb::text`'s `": true"` rendering and
  shipped permanently 0. Fixed to real `\\s` escapes (+ case-insensitive `~*`, truthiness
  widened to `true|"true"|1`), with a test asserting the literal `\s*:\s*` reaches SQL.
- **Splits failure no longer fabricates zeros (MAJOR)** — the route returns `splits: null` on
  aggregation failure; the client hides every subline AND the health verdict (a broken
  aggregation must not read "0 open ingress"/"healthy"). The home page already handled a
  missing splits.
- **L82 stays UNCHECKED (partial, the batch-5 L248 precedent)** — this batch covers the group
  overview surface only; the dashboard-home StatsCards, EKS ready splits, CloudFront
  HTTP-allowed, and WAF splits remain. Audit note, CHANGELOG wording, and this spec now say
  so explicitly.
- Lambda runtimes count container-image (null-runtime) functions as 'custom' (the
  inventory-derived COALESCE parity); the dead `cloudwatch_alarm` TYPE_MICRO entry is removed
  (singleton Monitoring group has no overview page); EBS subline says GiB; VPC subline adds
  TGW; the audit's truncated L82 line tail and the stale s3 'versioning not synced' blocker
  claim are repaired.
