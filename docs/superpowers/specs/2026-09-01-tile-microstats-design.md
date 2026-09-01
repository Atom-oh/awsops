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
  prop) per resource-type tile from splits/byType — v1 parity set: ec2 running/stopped, lambda
  runtimes/>300s, ebs GB/unencrypted, rds Multi-AZ/unencrypted, ecr scan-on-push/immutable, s3
  public/versioning-off, iam_user no-MFA, security_group open-ingress, cloudwatch_alarm
  in-alarm, cloudfront enabled, vpc subnets·NAT (cross-type counts from byType — zero SQL).
  Sublines render only after the summary loads (no fabricated zeros while loading); terms stay
  the technical English v1 used.

No Terraform/IAM/schema changes.

## Testing
- Route: new split keys mapped from the UNION-ALL rows; SQL carries the new aggregates;
  degrade-to-zeros still covers the widened set.
- Client: tiles show sublines when splits are present; no subline before load; vpc subline
  composes from byType.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-20 note; CHANGELOG EN/KO.
