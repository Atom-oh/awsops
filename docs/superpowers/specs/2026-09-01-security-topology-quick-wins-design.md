# Security/topology quick wins: issues-summary bars, loading state, flow legend — 3 gap-audit items (L245, L246, L248)

**Status:** Batch 28, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch28`.
**WA pillar:** Security / Operational Excellence (posture legibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L245 (Security Issues Summary bar
chart), L246 (security-page loading state on first fetch), L248 (topology color legends — the
remaining traffic-flow + status-dot half of the 2026-08-29 partial).

## Decisions
- **L245** — `/security` gains a `BarDistribution` "Security Issues Summary" in the chart row:
  one bar per issue class exactly as v1 shaped it — the 4 non-CVE checks by finding count plus
  **CVE Critical** and **CVE High** (summed from the ECR scan details, the same source as the
  CVE donut), **zero-value bars filtered**; the whole chart is omitted when every bar is zero
  (no empty card).
- **L246** — while the FIRST fetch is in flight (`data === null` and no error) the page renders
  the app-standard `로딩 중…` line (the `/inventory/[type]` precedent) instead of the current
  fabricated-looking zero-valued StatTiles / empty donut / empty table. The tiles/charts/table
  render only once `data` exists; a refresh keeps showing the previous data (no flicker).
- **L248** — two legends, closing the two named gaps of the partial item:
  - `/topology` (traffic-flow) stats row gains color chips for the **kinds present in the
    loaded graph** (KIND_LIGHT/KIND_DARK swatches, theme-aware) — and, because target nodes
    are colored by HEALTH instead of kind, target chips are the **health values present**
    (healthy/unhealthy/draining/initial) with the HEALTH palette. Chip labels are the literal
    kind/health values (the merged MapLegend precedent — English technical labels, no tt()).
  - `MapLegend` (map cards, infra/K8s views) is extended with the **status-dot legend**:
    one dot chip per `ok/warn/bad/neutral` status present in the graph, using the exact
    STATUS_DOT colors the cards already render.

Read-only presentational change; no API/sync/Terraform/schema changes.

## Testing
- Security page (jsdom): loading line shows before fetch resolves and disappears after; the
  issues-summary bars render v1's classes with zero bars filtered (and the chart is absent
  when all-zero).
- MapLegend: status dots render for present statuses only.
- Full `npm test` + `tsc` + build; gap-audit ticks with a batch-28 note; CHANGELOG EN/KO.
