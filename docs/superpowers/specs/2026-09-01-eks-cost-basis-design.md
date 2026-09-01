# EKS container-cost calculation-basis panel + 2 verified ticks — 3 gap-audit items (L217, L219, L220)

**Status:** Batch 25, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch25`.
**WA pillar:** Cost Optimization (calculation transparency).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L217 (Cost Calculation Basis
collapsible panel), L219 (i18n — VERIFIED ALREADY IMPLEMENTED), L220 (error/empty states —
VERIFIED ALREADY IMPLEMENTED).

## L219 / L220 — verification, not implementation
- **L219**: `OpencostPanel` routes every user-facing string through `tt()` and all of them
  (미설치/저장됨/관리자 전용/미온보딩/조회 제한/저장소 미설정/설치됨 · Ready …) are registered
  in TERMS/RULES — 4-language coverage exists. Ticked with a verification note.
- **L220**: `/eks/cost` ships the red error banner (로드 실패), a loading state, a
  no-clusters empty state, per-cluster 미가용 chips, the estimate-fallback disclosure banner,
  and scoped no-data placeholders. Ticked with a verification note.

## L217 — Cost Calculation Basis panel
- New `CostBasisPanel` (collapsible ▶ toggle, mounted at the bottom of `/eks/cost`): pure
  static transparency content documenting the V2 basis (deliberately NOT v1's per-instance
  EC2 price grid — v2 doesn't price by instance type):
  - Method comparison table (5 cost items × 2 methods): OpenCost 실측 measures CPU / RAM /
    Network / PV / GPU from the allocation API; 요청 기반 추정 covers CPU + RAM only
    (network/PV/GPU read 0).
  - Formula block: estimate daily = vCPU request × $0.04656/vCPU-h × 24h + memory(GB) ×
    $0.00511/GB-h × 24h (Fargate-style on-demand, ap-northeast-2).
  - Worked example: a pod requesting 0.5 vCPU + 1 GB → $0.559 + $0.123 ≈ $0.68/day.
  - Caveats list: unit prices are Fargate-style on-demand (not per-instance-type EC2 pricing),
    Spot/RI/Savings-Plans discounts are NOT reflected, Succeeded pods are excluded, requests ≠
    actual usage (over/under-requesting skews the estimate), monthly = daily × 30, and
    network/PV/GPU costs appear only with OpenCost installed.
- **Single price source**: the unit constants move to `web/lib/cost-basis.ts`
  (`ESTIMATE_UNIT_PRICES`), imported by BOTH `opencost-allocation.ts` (the estimator) and the
  panel — the documented numbers can never drift from the computed ones.
- 4-language i18n for the panel strings.

## Testing
- cost-basis: the estimator uses the exported constants (lockstep by import — plus a unit
  test pinning the values and the worked example).
- Panel: renders collapsed, expands to the table/formula/example/caveats.
- Full `npm test` + `tsc` + build + pytest; gap-audit ticks with a batch-25 note; CHANGELOG EN/KO.
