# Dashboard on-demand sync + resource-tile micro-stat sublines — 2 gap-audit items (L79, L82)

**Status:** Batch 36, 2026-09-03 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch36`.
**WA pillar:** Operational Excellence (data freshness on demand / at-a-glance state decomposition).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L79 (force-refresh → on-demand
sync), L82 (dashboard resource-tile micro-stat sublines).

## Decisions

- **L79** — the dashboard header gains an admin-only **force-sync** action beside the existing
  Refresh button. v1's `?bustCache=true` was a SYNCHRONOUS live requery; v2's collection is the
  batch Steampipe sync, so the honest v2 counterpart is an ON-DEMAND SYNC TRIGGER with async
  semantics, disclosed in the UI ("sync 시작됨 — 데이터는 수 분 내 반영").
  - **No new route**: the existing admin-only `POST /api/inventory/[type]/refresh` special-cases
    `type === 'all'` → `triggerSync('all')` (ONE Event invoke; the sync Lambda's own `type=all`
    fan-out dispatches every registered type under its reserved-concurrency backpressure —
    exactly the scheduled EventBridge path). No `readResources('all')` (not a type); the
    response is `{ status:'queued', dispatched:'all' }`. The per-type
    `assertInventoryTypeAllowed` gate is skipped for 'all' — the caller is already admin-gated,
    and the fan-out's per-type Lambdas write to Aurora directly (no rows are returned to the
    caller, so the ADMIN_ONLY_TYPES read-gate is not in play).
  - **UI**: `RefreshButton` gains an optional `onForceSync` prop (no new component; pages
    without the prop are unchanged). Click → POST → transient states: queued note (async
    disclosure), 403 → "관리자 전용" note, 503 (steampipe disabled/unset INV_SYNC_FUNCTION) →
    "sync 비활성" note. No optimistic data mutation — the user re-loads via the normal Refresh
    once the sync lands.
- **L82** — dashboard resource tiles get v1's state-decomposition sublines. The derived
  numbers ALREADY exist: `/api/inventory/summary`'s `splits` (built for the group-overview
  pages) + `byType` cross-counts + the dashboard's own live EKS fleet aggregate.
  - **Shared map**: the group page's `TYPE_MICRO` map moves to a new shared lib module
    `web/lib/tile-micro.tsx` (`typeMicroLine(type, splits, countOf)`) so the dashboard and the
    group overview render the same decomposition without drift; the dashboard additionally
    registers `ecs_cluster` (`N services · M tasks`, byType cross-count) and `waf`
    (`N rule groups · M IP sets`, byType cross-count) entries, and keeps the live EKS subline
    (`N/M ready · K pods`) inline in page.tsx (fleet data is a dashboard-local live read).
  - **StatTile**: compact size gains an optional `micro` line (10.5px muted, single line,
    truncated) — compact deliberately has no hint/trend, so this is a NEW, narrower slot; no
    change to default-size tiles or existing pages.
  - **Honesty**: a subline renders only when its inputs are loaded (no fabricated zeros while
    loading; an undefined split — rolling-deploy skew — drops just that subline, matching the
    group page's contract). Technical terms stay English as v1 rendered them.
  - Types with no meaningful decomposition today (dynamodb, elasticache, opensearch, msk,
    cloudtrail, iam_role, AgentCore) keep plain counts — the audit's enumerated v1 set is
    covered by splits/byType/fleet.

## Testing
- refresh route: `type=all` → admin-only (403 non-admin), queued dispatch, 503 when
  INV_SYNC_FUNCTION unset, per-type path unchanged.
- RefreshButton: force-sync states (queued/forbidden/error), absent prop → unchanged render.
- tile-micro: per-type strings incl. the new ecs_cluster/waf cross-counts; undefined-split
  drop behavior.
- StatTile: compact micro renders; absent micro unchanged.
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}`; lib module count
  134 → 135; gap-audit ticks + batch-36 note; CHANGELOG EN/KO; i18n terms registered.
