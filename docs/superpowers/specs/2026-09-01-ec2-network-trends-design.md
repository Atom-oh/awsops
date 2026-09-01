# EC2 Network In/Out monitoring — 1 gap-audit item (L139)

**Status:** Batch 17, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch17`.
**WA pillar:** Performance Efficiency (network utilization visibility).

Closes gap-audit item (docs/v1-gap-audit-2026-07-19.md): L139 (EC2 Network In/Out — table
columns + per-instance time-series chart panel).

## What v2 already has vs. the remaining gap
The EC2 diagnostics table (`Ec2Metrics`, `ec2DiagFleetLive`) already renders fleet-wide
Net In/Out (Mbps) and PPS columns over the selected range — the v1 "per-instance Net In/Out
columns" half of L139 is live. The remaining gap: the **Private IP column** and the **per-row
chart drill-down** (slide-in panel with NetworkIn + NetworkOut 24-hour hourly line charts and
Total In/Out 24h stat tiles).

## Decisions
- **Lib** `ec2NetworkTrends(instanceId, accountId?, region?)` (`web/lib/metrics.ts`): ONE
  bounded read-only GetMetricData — NetworkIn/NetworkOut, `Stat: Sum`, Period 3600 over a
  24-hour window, `ScanBy: 'TimestampAscending'`; returns `{ netIn, netOut }` as
  `TrendSample[] | null` per series (missing/empty series → null; any CloudWatch error
  degrades BOTH to null — the module's never-throw contract). Account/region thread through
  `assumedClient` exactly like `liveResourceTrends` (member-account + off-region instances
  chart their OWN metrics — the PR #258 lesson, applied from the start).
- **Route** (ec2 branch of `/api/inventory/[type]/metrics`): new `?id=i-...&trends=1` path
  returning ONLY `{trends}` (the established trends=1 contract); id validated
  `/^i-[0-9a-f]{8,17}$/`, account `self|12-digit`, region AWS-shape — each → 400. The fleet
  `?ids=` and KPI-cards paths are untouched.
- **UI**:
  - `Ec2Metrics` gains a Private IP column (`private_ip_address`, already synced) and
    `onRowClick` (MetricTable's existing prop) opening the chart panel.
  - New `Ec2NetworkPanel` (named export): right slide-in panel (overlay click / Escape / ×
    close) with two hourly `AreaTrend` charts (NetworkIn, NetworkOut — MB per hour, KST axis
    labels per the RdsTrendsSection precedent) + Total In/Out (24h) stat tiles summed from the
    series. Missing series → '데이터 불가'; fetch failure / 200-without-trends
    (rolling-deploy skew) → inline error branch, never a pinned loading state.

No Terraform/IAM/schema changes (GetMetricData is already granted; no new columns).

## Testing
- Lib: window ≤25h & Period 3600 & ascending; both metrics in one call; error → both null;
  empty series → null; account/region forwarded to the client factory.
- Route: trends=1 returns only `{trends}` (no fleet/cards call); malformed id/account/region
  → 400; default paths unchanged.
- Component: charts + total tiles render from samples; null series → 데이터 불가; skew/fetch
  error branch; Escape/overlay close.
- Full `npm test` + `tsc` + build + pytest; gap-audit tick with a batch-17 note; CHANGELOG EN/KO.
