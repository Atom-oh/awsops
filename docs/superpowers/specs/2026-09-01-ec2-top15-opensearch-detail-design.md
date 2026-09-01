# EC2 CPU Top 15 chart + OpenSearch structured detail — 2 gap-audit items (L138, L150)

**Status:** Batch 15, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch15`.
**WA pillar:** Performance Efficiency (utilization visibility) / Operational Excellence
(configuration readability).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L138 (EC2 per-instance CPU Top 15
bar chart), L150 (OpenSearch detail-panel JSONB structured rendering).

## Decisions

### L138 — EC2 CPU Top 15 bar chart
- **Lib** `ec2CpuStats(instanceIds)` (`web/lib/metrics.ts`): the existing `ec2AvgCpu`
  GetMetricData call already fetches a per-instance latest value and throws it away after
  averaging. Refactor the body into `ec2CpuStats → { avg, byInstance }` (ONE CloudWatch call,
  identical query) and keep `ec2AvgCpu` as a thin wrapper — no extra API cost, no caller churn.
- **Route** (ec2 branch of `/api/inventory/[type]/metrics`): the fleet SQL additionally selects
  the instance Name tag; the response gains `bar: { title: 'EC2 CPU Top 15 (%)', data:
  [{label, value}] }` — top 15 running instances by latest CPU descending, label = Name tag or
  instance id. Omitted when no instance reports a datapoint (the cards degrade to '—' as
  today). Existing `cards` shape untouched.
- **UI** (`web/app/inventory/[type]/page.tsx`): a generic `metricBar` state renders any
  `bar` payload from the metrics route as a `BarDistribution` in the chart row (count-desc
  default sort = the ranking order we want). Generic by design — a future type can return its
  own `bar` without page changes.

### L150 — OpenSearch detail-panel structured rendering
- **Pattern**: follow the established DERIVERS flattening (`web/lib/inventory-derived.ts`) —
  derive readable `*_h` fields from the JSONB blobs and reference them from the spec's
  `sections`, instead of a bespoke React section (the MSK/DynamoDB precedent).
- **New derived fields** (opensearch): `dedicated_master_h` (type × count or disabled),
  `zone_awareness_h` (+AZ count), `warm_storage_h`, `cold_storage_h`, `multi_az_standby_h`
  (from `cluster_config`); `ebs_volume_h` (type/size/IOPS/throughput one-liner from
  `ebs_options`); `vpc_id_h`/`subnets_h`/`security_groups_h`/`azs_h` (from `vpc_options`);
  `kms_key_h` (from `encryption_at_rest_options`); `adv_security_h`/`internal_user_db_h`/
  `anonymous_auth_h` (booleans → Badge rendering, from `advanced_security_options`);
  `cognito_h`. All lookups via the existing case-insensitive `walk` (Steampipe JSONB mixes
  casings).
- **Spec** (`inventory-types.ts` opensearch): sections rework — Identity / Cluster Config /
  Engine / Endpoint & Network / Security / Storage / Tags, referencing the derived fields.
- **`hideKeys` (new generic InvType field)**: raw JSONB keys replaced by structured fields
  (`cluster_config`, `ebs_options`, `vpc_options`, `encryption_at_rest_options`,
  `advanced_security_options`, `cognito_options`) are marked used-but-hidden in
  `buildDetailGroups` so they don't leak back through the "Other" group. Generic, unit-tested.
- Labels for the new keys registered in `VIRTUAL_LABELS` (avoid `Dedicated Master H`-style
  humanize artifacts).

No Terraform/IAM/schema changes — CloudWatch `GetMetricData` is already on the web task role;
the OpenSearch JSONB columns are already synced.

## Testing
- Lib: `ec2CpuStats` returns per-instance map + the same avg contract (empty → {null, {}});
  `ec2AvgCpu` wrapper equivalence.
- Route: ec2 response carries `bar` (top-15 desc, Name-tag labels, id fallback), omitted on
  no-data; cards unchanged.
- Derived: each new opensearch `*_h` field (enabled/disabled branches, missing JSONB → undefined).
- Detail: `hideKeys` suppresses raw keys from sections AND the Other group; types without
  hideKeys byte-identical.
- Full `npm test` + `tsc` + build; gap-audit ticks with a batch-15 note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **Fleet-wide per-region ranking (the gate MAJOR)** — the first cut ranked an unordered
  ≤100-instance, default-region-only sample under a "Top 15" title. `ec2CpuStats` now takes
  `idsByRegion` and routes each region's ids through `fleetLatest`'s chunked GetMetricData
  (per-region CloudWatch clients, ~480 queries/call batches, fail-soft per region); the route
  groups running instances by their inventory region (the `?ids=` diagnostics `byRegion`
  precedent). The average is computed from RAW datapoints (no rounded-value drift); the dead
  `ec2AvgCpu` wrapper is removed. CHANGELOG/audit wording updated to the now-true claim.
- **Chart value precision** — `HBarList`/`BarDistribution` gained a `decimals` prop; the CPU
  chart renders 1 fraction digit instead of flooring 12.1% to "12".
- **Deriver honesty/tolerance** — boolean lookups use a tolerant `flag()` (accepts
  `'true'`/`'false'` strings, boolH parity), and an empty `{}` blob yields `undefined`
  (absent from the panel) instead of a fabricated 'disabled'.
- **Info availability** — the raw `advanced_security_options`/`cognito_options` blobs stay
  visible in the Security section (SAML/user-pool fields aren't derived); final `hideKeys` =
  `cluster_config`, `ebs_options`, `vpc_options`, `encryption_at_rest_options`,
  `node_to_node_encryption_options_enabled`, and the derived table column `storage_gb_h`
  (superseded in the panel by `ebs_volume_h`).
- **Array rendering** — subnet/SG/AZ lists pass through as raw arrays so `formatDetailValue`'s
  one-per-row idlist rendering applies (v1's chip list), not a comma-joined line.
