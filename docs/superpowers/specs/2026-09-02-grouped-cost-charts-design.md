# Grouped cost charts: ECS Cost by Service, EKS node cost + pods — 2 gap-audit items (L195, L218)

**Status:** Batch 34, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch34`.
**WA pillar:** Cost Optimization (cost-composition visibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L195 (container-cost Cost by
Service CPU vs Memory grouped bar), L218 (eks-container-cost Node Daily Cost + Pod Count).

## Decisions
- **New primitive `GroupedBarList`** (charts/, as amended by round 1) — the multi-series
  extension both items need: per row, one thin track PER SERIES, legend chips, formatted
  value labels. Scaling is PER-CALLER: same-unit series (L195's $ vs $) share ONE scale via
  `sharedScale` — per-series would render the largest Memory bar as wide as the largest CPU
  bar and destroy the comparison — while mixed-unit series (L218's $ vs pod count) scale each
  to its own max, the honest equivalent of v1's dual axis. (v1's L195 chart was a shared-
  scale stacked $ chart, NOT dual-axis; only L218 was dual-axis.)
- **L195** — new `EcsCostByService` metrics component on the ECS Tasks inventory page (the
  existing per-type embed slot): FARGATE tasks group by their `group` value's `service:` name
  (rows without a service group or with EC2 launch type are EXCLUDED — the deriver gives EC2
  tasks no estimate, and a bar must not mix estimated and unestimated populations), the
  CPU/Memory daily-cost split comes from the SHARED `estimateDailyParts` (the batch-25
  single-source rule — the same constants the Daily $ column uses), top 10 by total. Renders
  nothing when no eligible rows.
- **L218** — `/eks/cost` gains a "Node별 일일 비용 + Pod 수" GroupedBarList above the node
  cost table: cost ($/day, from the existing OpenCost per-node allocation) and pod count
  (counted client-side from the SAME merged pods list, matched by cluster+node — no new
  fetch). v1's dual-axis becomes per-series-scaled grouped bars (deliberate idiom deviation,
  disclosed). Renders only when the node list is non-empty; a node with zero matched pods
  shows a real 0 (the pods list is the page's own data, not an unknown).

## Testing
- GroupedBarList: per-series vs sharedScale track widths + legend/format labels (real test).
- EcsCostByService: service grouping (strips `service:`), EC2/no-group exclusion, top-10 cap,
  parts from estimateDailyParts (lockstep by import).
- Full `npm test` + `tsc` + build; component counts 105 → 107 (README ×4,
  web/components/CLAUDE.md); gap-audit ticks + batch-34 note; CHANGELOG EN/KO; docs-site 4
  locales.

## Round-1 corrections (review-driven)

- **sharedScale for same-unit series (the gate MAJOR)** — per-series scaling on two $ series
  visually equalized unequal CPU/Memory costs, the exact comparison L195 exists for (v1's
  chart was shared-scale stacked $, not dual-axis — the provenance claim was wrong in the
  CHANGELOG/spec/audit note and is amended in place). GroupedBarList gains `sharedScale`;
  ECS uses it, EKS keeps per-series; a new GroupedBarList test pins both scaling modes (the
  spec's testing claim previously named a test that didn't exist).
- **Cluster-scoped service keys (the gate MAJOR)** — service names are unique only within a
  cluster; bars now key and label as `cluster/service` (test: same-named services in two
  clusters stay separate).
- **The 500-row truncation signal (the gate MAJOR)** — EcsCostByService now receives
  `isTruncated` and appends the page's standard `(표본 기준)` label (the in-file
  one-signal-for-every-sample-consumer convention).
- Minors: /eks/cost pod counts precompute a cluster/node Map (was O(nodes×pods) per render),
  rows sort cost-desc (the primitive's callers-sort contract), and the pods series is DROPPED
  when no pod carries node attribution (a confident 0 must not stand in for unknown);
  CHANGELOG's serviceless wording corrected (excluded for lack of a grouping key, not lack of
  an estimate).

## Round-2 corrections (review-driven)

- **ECS keys on the FULL cluster_arn (the gate MAJOR)** — round 1 keyed on the short cluster
  name, which merges same-named clusters across regions/accounts (ECS's implicit `default`
  exists per region per account); the short name stays the display label (test: two
  same-named clusters render two bars).
- **Pod attribution is judged PER CLUSTER with per-node OMISSION (the gate MAJOR)** — the
  fleet-global flag let one attributed cluster flip confident 0s onto another cluster's
  unattributed nodes (mixed measured/request-estimate fleets); a node whose cluster has no
  attributed pods now renders '—' (GroupedBarList gains null-value omission — tested), never
  a zero.
- Minors: `> 0` guards on cpu/memory (a null/'' coerced 0 must not contribute $0.00 —
  tested); the node chart caps Top 15 with a count-labeled title; the doc quotes use the
  SHIPPED localized labels (en 'sampled' / zh '基于样本' / ja 'サンプル基準' — the zh typo
  fixed).
