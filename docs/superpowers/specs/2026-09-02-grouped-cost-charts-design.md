# Grouped cost charts: ECS Cost by Service, EKS node cost + pods — 2 gap-audit items (L195, L218)

**Status:** Batch 34, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch34`.
**WA pillar:** Cost Optimization (cost-composition visibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L195 (container-cost Cost by
Service CPU vs Memory grouped bar), L218 (eks-container-cost Node Daily Cost + Pod Count).

## Decisions
- **New primitive `GroupedBarList`** (charts/) — the multi-series extension both items need
  (v2's BarDistribution/HBarList are single-series): per row, one thin track PER SERIES,
  each track scaled to ITS OWN series max, with a legend chip row and per-value formatted
  labels. Per-series scaling is the honest equivalent of v1's dual-axis chart (two series,
  two scales) — mixing units on one shared scale would let a large series visually flatten
  the other; the formatted value labels carry the real numbers/units.
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
- GroupedBarList: renders per-series tracks scaled to each series' own max; legend labels.
- EcsCostByService: service grouping (strips `service:`), EC2/no-group exclusion, top-10 cap,
  parts from estimateDailyParts (lockstep by import).
- Full `npm test` + `tsc` + build; component counts 105 → 107 (README ×4,
  web/components/CLAUDE.md); gap-audit ticks + batch-34 note; CHANGELOG EN/KO; docs-site 4
  locales.
