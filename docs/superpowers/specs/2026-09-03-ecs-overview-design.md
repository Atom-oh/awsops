# ECS unified overview page — 1 gap-audit item (L216)

**Status:** Batch 37, 2026-09-03 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch37`.
**WA pillar:** Operational Excellence (one-screen ECS posture: KPI + clusters + services).

Closes gap-audit item (docs/v1-gap-audit-2026-07-19.md): L216 (클러스터+서비스 통합 단일
페이지 뷰 — v1 showed summary KPI, cluster table, and service table on ONE screen; v2 splits
them across three sidebar leaves with no ECS-subgroup overview).

## Decisions

- **Route**: NEW page `/inventory/ecs` (static route — Next.js static segments beat the
  `/inventory/[type]` dynamic catch-all, and `ecs` is not an inventory type, so no spec/route
  collision; the generic API route is untouched). Registered in the sidebar's existing ECS
  subgroup as a `links` entry (the EKS-subgroup pattern; the sidebar renders a subgroup's
  `types` before its `links`, so the overview link sits after the three type leaves), with a
  new `nav.ecsOverview` key in all 4 languages. Pages 40 → 41.
- **Component**: `web/components/inventory/EcsOverview.tsx` (components 109 → 110) — client
  page, v1 parity on one screen:
  - **KPI band**: cluster/service counts from the fetched pages themselves ('+' suffix at
    the 500 cap — the tiles describe exactly what the tables below show), the task count from
    `/api/inventory/summary` byType, plus service-health tiles derived from the
    fetched service rows (running/desired task rollup; a desired>running mismatch tile is the
    attention signal). Rollups render only when the service rows are loaded and the page is
    NOT truncated — a 500-row sample must not present a fleet-wide sum as authoritative
    (rendered with the `(표본 기준)` qualifier instead).
  - **Clusters table**: from `/api/inventory/ecs_cluster?limit=500` — Name, Status,
    Running/Pending tasks, Services, Region (the type page's column set, compacted). **Services table**: from `/api/inventory/ecs_service?limit=500` — Service,
    Cluster (ARN leaf), Status, Desired/Running, Launch, Region. Each table header carries a
    "전체 보기 →" link to its full type page (search/facets/detail live there — the overview
    is read-only glance parity, row click intentionally NOT wired to DetailPanel to keep this
    page thin; the deviation from v1's single do-everything page is disclosed here).
  - **Honesty**: per-type sync-run status rides the existing `{rows, run}` API contract — a
    non-succeeded run renders a stale-data caption on that table; `rows.length >= 500` labels
    the table `(표본 기준)`; pre-sync (empty rows + no run) reads "미수집" rather than a
    fabricated empty fleet.
- **Docs**: docs-site container/ECS guide updated in 4 locales; api-reference unchanged (no
  new API); CHANGELOG EN/KO; audit tick + dated batch-37 note.

## Testing
- EcsOverview: KPI derivation (counts, running/desired rollup gated on untruncated loaded
  rows), truncation labels, stale-run caption, pre-sync state, table rendering.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; page/component
  counts 40→41 / 109→110; nav key registered in 4 languages.

## Round-1 corrections (review-driven)

- **The page honors the global account/region scope (the gate MAJOR)** — all three fetches
  now append `scopeParams(scope)` and reload on scope change (the type page's exact
  template); the overview describes the same fleet its '전체 보기' links open.
- **The deficit KPI is per-service (the gate MAJOR)** — `Σ max(0, desired − running)` per
  service: a mid-deployment surplus (maximumPercent 200) must never cancel another service's
  shortfall, and the tile can no longer go negative. Rows with absent desired/running fields
  are skipped from the deficit (their cells render '—' — an unknown must not inflate the
  number). The aggregate running/desired hint stays.
- **The task tile never fabricates a pre-sync 0 (the gate MAJOR)** — a never-synced type is
  ABSENT from the summary's byType (GROUP BY), so absence now stays null ('—'); the pre-sync
  test stubs an EMPTY summary so the fixture actually catches it.
- Minors: the header freshness is the DATA time (the newer of the two runs' finished_at),
  never the browser fetch time — all-failed fetches read 미수집, and the stale badge can
  actually fire; non-succeeded run captions are state-specific (failed asserts failure,
  running/partial say what they are) and a missing ledger row WITH rows present reads
  "freshness unverifiable"; the spec's phantom 'Instances' column is dropped (the component
  never rendered it); the docs-site caption wording covers all non-succeeded states.
