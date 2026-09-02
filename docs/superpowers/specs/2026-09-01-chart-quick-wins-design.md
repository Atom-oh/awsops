# Chart quick wins: ElastiCache node-type bar + OpenSearch encryption donut — 2 gap-audit items (L221, L236)

**Status:** Batch 27, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch27`.
**WA pillar:** Security / Operational Excellence (fleet composition visibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L221 (ElastiCache Node Type
Distribution bar), L236 (OpenSearch Encryption Status distribution donut).

## Decisions
- **L221** — new generic `InvType.countBarKey?: { col, label }`: row COUNTS per distinct value
  of `col`, rendered as a count-descending `BarDistribution` in the chart band (distinct from
  `barKey` = Top-N numeric ranking and `histKey` = numeric-axis histogram). `elasticache` sets
  `countBarKey: cache_node_type` and DROPS `distKey2: cache_node_type` (the same dimension
  must not render as both a donut and a bar) — v1 parity: engine pie + node-type bar.
- **L236** — new opensearch derived field `encryption_status_h`: **Full Encryption** (at-rest
  AND node-to-node both true) / **Partial** (exactly one true) / **No Encryption** (both
  false) / undefined when EITHER side is unknown (tri-state honesty — an unknown must never
  count as No). `distKey2` switches from `engine_type` (not a v1 chart) to
  `encryption_status_h` with semantic `distKey2Colors` (Full=green, Partial=amber, No=red).

Read-only; no sync/Terraform/schema changes.

## Testing
- countBarKey: page renders the count bar (covered by registry invariants + a deriver-level
  countBy check); spec invariant tests keep passing (countBarKey.col validated like barKey).
- encryption_status_h: all four states (Full/Partial/No/unknown-either-side).
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-27 note; CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **Unknown domains really are excluded from the donut (the gate MAJOR)** — countBy buckets
  undefined as '(none)' and distData2 applied no filter, so unknowns rendered as a
  positional-palette slice inside the denominator. New `distKey2DropNone` spec flag (set for
  opensearch) filters the bucket at the page level.
- **The donut is titled 'Encryption Status 분포' (the gate MAJOR)** — colLabel falls back to
  the raw key for derived-only fields; new `distKey2Label` spec option supplies the title.
- `encryption_status_h` joins the detail Security section (no more humanized leak into
  Other); `countBarKey` data is top-10-capped, '(none)'-filtered, and useMemo'd ABOVE the
  !spec early return (the histData hooks lesson); the CHANGELOG wording says 'in the chart
  band' instead of 'beside'.
