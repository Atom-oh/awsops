# Cost page quick wins: KPI tiles, CE onboarding banner, table encoding — 3 gap-audit items (L196, L197, L198)

**Status:** Batch 24, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch24`.
**WA pillar:** Cost Optimization (spend-surge visibility / onboarding).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L196 (Daily Average + Last Month
tiles, ">20% increasing" sub-metric), L197 (Cost Explorer onboarding banner), L198 (service
table threshold colors + share mini bars).

## Decisions
- **L196** — KPI row grows from 5 to 7 tiles (`lg:grid-cols-4`, wrapping): (a) **Daily
  Average** — mean of the FILTERED daily totals over the trailing-30d series ('—' when the
  series is empty); (b) **Last Month** standalone total ('—' when no prior month); (c) the
  Services tile gains v1's change subtext — 'N개 >20% 증가' counting `changeRows` where
  `change > 20 && previous > 0` (new services with previous=0 have change pinned to 0 by
  `serviceChangeRows` and are never counted as surging).
- **L197** — when the load SUCCEEDED but every series is empty (no monthly, no daily, no
  service rows), an info banner (distinct from the error banner) explains the likely cause:
  Cost Explorer may not be enabled — enable it in the AWS Billing console; data can take up
  to 24h to appear. The existing empty-card texts stay for partial emptiness.
- **L198** — the service detail table moves from DataTable (no cell renderers) to the shared
  `MetricTable` (typed numeric sort + custom renders, the inventory-metrics precedent):
  the Change cell is threshold-colored (>20% red · >0 orange · <0 green; 0/no-baseline
  neutral), and the Share cell renders v1's mini progress bar + percentage. Row click keeps
  opening the service drill-down; numeric sorting now works on real numbers instead of
  formatted strings.

Read-only; no API/Terraform changes. 4-language i18n for the new strings.

## Testing
- Page-level helpers stay in lib/cost.ts (no change); the new tile math is presentational.
- Component test for the cost table cells is impractical (page-level) — MetricTable's own
  suite covers sort/render plumbing; tile/banner logic asserted via a lightweight page test if
  feasible, else covered by tsc + the existing suite.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-24 note; CHANGELOG EN/KO.
