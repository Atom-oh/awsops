# Full-fleet server-side aggregates for capped inventory pages — 1 gap-audit item (L102)

**Status:** Batch 39, 2026-09-03 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch39`.
**WA pillar:** Operational Excellence (accurate fleet-wide KPI/donut counts past the 500-row cap).

Closes gap-audit item (docs/v1-gap-audit-2026-07-19.md): L102 (v1 ran summary/statusCount/
typeDistribution SQL over the WHOLE fleet; v2 computes KPI/donut/facet counts client-side from
the 500-row sample — silently inaccurate above 500 resources).

## Decisions

- **Generic, not ec2-only**: the aggregation is driven by the type spec's existing keys
  (`stateKey`/`distKey`/`distKey2`/`filterKeys`), so EVERY capped inventory page gets
  full-fleet numbers — ec2 is the audit item, the mechanism is shared (the same shape v1's
  per-page SQL had).
- **API**: `GET /api/inventory/[type]?view=agg` (no new route) returns
  `{ total, state, dist, dist2, facets }` — full-fleet GROUP BYs over `inventory_resources`
  scoped by the SAME accounts/regions params as the rows. Keys are SPEC-sourced (trusted
  code) and still charset-validated (`^[a-z0-9_]{1,64}$`) before inlining (the worstFirst
  defense-in-depth precedent); bucket names are `COALESCE(NULLIF(data->>'k',''),'(none)')`,
  each GROUP BY capped at 50 buckets (count-desc). Same verifyUser +
  `assertInventoryTypeAllowed` gates as the row read (aggregates leak the same data class).
- **Page wiring**: fetched only when the row fetch hits the cap (replacing the L110
  summary-based true-total fetch — `aggs.total` is the same scoped count, one heavy call
  instead of two). When aggregates are present: the KPI state tiles, both donuts, the state
  filter options, and the facet dropdown options use FULL-FLEET buckets; when the agg fetch
  fails, everything degrades to the sample as before and the donut titles gain the
  `(표본 기준)` qualifier (previously the capped donuts were silently sample-based with no
  label — the fallback is now disclosed).
- **Deliberately still sample-based (disclosed)**: the table itself (500-row page), the
  Top-N numeric bars/histograms (row-level values, already 표본-labeled where configured),
  and the per-type highlight cards (their `capped` flag already qualifies them). A facet
  value that exists only beyond the cap now APPEARS in the dropdown (full-fleet option list)
  but filters the visible sample — the shown/total counter makes the sample scope explicit.

## Testing
- lib `readAggregates`: WHERE/scope construction mirrors readResources; key validation
  (invalid spec keys skipped); (none) coalescing; per-key bucket shape; facets map.
- route: `view=agg` returns aggregates with the same gates and scope parsing, and does not
  read rows.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; audit tick +
  batch-39 note; CHANGELOG EN/KO; docs-site resources guide note (4 locales) if the page
  behavior is user-visible.

## Round-1 corrections (review-driven)

- **Client-derived spec keys are excluded from the server aggregate (the gate CRITICAL)** —
  `readAggregates` read every key as raw `data->>'k'`, but several spec dimensions are
  fabricated/transformed by `deriveRow` (dynamodb `billing_h` → 100% '(none)', ecs_task
  `cluster_h`/`cpu_h`/`memory_h`, opensearch `encryption_status_h` under DropNone → the
  donut vanished, lambda `runtime` losing the null→'custom' COALESCE, `vpc_h`, msk
  `kafka_version`) — confidently wrong full-fleet buckets replacing correct sample data,
  with the sample qualifier suppressed. `AGG_DERIVED_KEYS` (exported next to DERIVERS,
  lockstep-commented) drives the exclusion; those dimensions stay sample-based and each
  donut now discloses ITS OWN fallback (per-dimension `(표본 기준)` tags). Tests pin all 7
  keys across the 5 types.
- **Donuts sum to the fleet and facets never trust an at-cap list (the gate MAJOR)** — the
  page's 기타 was computed from buckets 7–50 only, silently dropping rank-51+ values of
  high-cardinality dimensions; the remainder is now `total − Σ(top6)` when aggregates are in
  use (기타 covers everything beyond the head, regardless of the 50-bucket cap; the DropNone
  donut keeps bucket-sum semantics — dropped '(none)' rows must not reappear as 기타). The
  GROUP BY gains a deterministic tiebreak (count DESC, name ASC), and an option list that HIT
  the 50 cap falls back to the sample (an arbitrary top-50 can even miss values visible in
  the loaded table).
- **One bounded round-trip (the gate MAJOR)** — the serial 1+N unbounded query chain on the
  shared `max: 3` pool is now a single UNION ALL statement inside a scoped transaction with
  `SET LOCAL statement_timeout` (the web/lib/auth.ts pool-starvation precedent); ROLLBACK +
  release on failure test-pinned. The agg branch returns a generic 503 on failure (no raw pg
  text) — the page falls back to the disclosed sample.
- Minors: `Object.hasOwn` guard on the type registry lookup (empty shape, no pool touch);
  buckets re-sorted client-side (UNION ALL branch order is not guaranteed). Recorded
  follow-ups: `view=agg` ignores sync-run staleness (same property as the replaced summary
  total — a stale-but-succeeded aggregate reads authoritative); rows and aggregates are two
  unsynchronized reads; a beyond-the-sample filter selection shows an empty table without a
  'not in the loaded sample' hint.
