# Compliance completion mail, ECS cost basis panel, cost impact estimation — 3 gap-audit items (L192, L194, L225)

**Status:** Batch 30, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch30`.
**WA pillar:** Operational Excellence / Cost Optimization.

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L192 (compliance completion SNS
email), L194 (container-cost Cost Calculation Basis panel), L225 (inventory-home Cost Impact
Estimation panel).

## Decisions
- **L192** — `compliance.notify_completed(...)`: best-effort SNS publish after a benchmark run
  persists as succeeded (benchmark name, scope, total/alarm/ok/pass-rate, `/compliance` link) —
  the `diagnosis/notify.publish_report` pattern (NEVER raises; notification must not fail the
  run). Reuses the EXISTING notify plumbing end-to-end: the same `DIAGNOSIS_SNS_TOPIC_ARN`
  env + topic + `sns:Publish` grant the Fargate worker already carries when
  `diagnosis_notify_enabled` (ZERO Terraform change — flag off ⇒ env absent ⇒ silent no-op),
  and the same `diagnosis_notify_paused` app_settings admin pause (paused ⇒ skip publish;
  pause-read failure fails OPEN to publishing, the digest precedent). Called from the
  `_compliance` handler after `persist`; failures print and return None.
- **L194** — the ECS Tasks inventory page (v2's container-cost surface — it already carries
  the cost KPI tiles and the Daily $ bar) gains a collapsible `EcsCostBasisPanel` (the
  batch-25 `CostBasisPanel` precedent), mounted via the existing per-type embed slot. The
  ecs_task deriver's duplicated `0.04656/0.00511` constants are REPLACED by imports from
  `web/lib/cost-basis.ts` (the single-source rule that batch 25 established — the panel's
  documented numbers and the computed ones cannot drift). Content: unit-price table
  (vCPU-h/GB-h, Fargate on-demand ap-northeast-2), the formula in the deriver's own units
  (`cpu units/1024 × $/vCPU-h × 24h + memory MB/1024 × $/GB-h × 24h`), a worked example
  (512 CPU units + 1024 MB), and caveats: **Fargate launch-type only** (EC2 launch-type tasks
  get no estimate — the deriver leaves them undefined), monthly = daily × 30, prices are
  static constants (v1's config.json override does not exist in v2), **ephemeral storage is
  not priced** (a deliberate deviation from v1's 3-row table — v2's estimator has no storage
  term), Spot/Savings-Plans discounts not reflected. 4-language i18n.
- **L225** — the home dashboard gains a "월 비용 영향 추정" list beside the trend delta
  table: 30-day count delta per resource type × a STATIC monthly-unit-cost heuristic
  (`web/lib/cost-impact.ts`, v1's static-weight approach with ap-northeast-2-flavored
  approximations), rendered as `±$N/mo est.` sorted by |impact| descending (top 8). Honest
  bounds: a type with no 30d baseline (the delta table's own '—' semantics) or no weight
  entry contributes NOTHING (never a fabricated $0 delta); the panel renders only when at
  least one row qualifies; an explicit disclaimer marks it a static heuristic, not billing
  data (실제 청구 아님 — Cost 페이지가 실측). Pure client; no new fetch, no new component
  file (inline dashboard section).

## Testing
- `notify_completed`: publishes with topic + not paused (subject/body carry benchmark +
  counts); no-op without topic; paused ⇒ skip; pause-read failure ⇒ publish (fail-open);
  publish exception swallowed (never raises).
- `cost-impact`: weights are static; delta × weight math; null-baseline and unweighted types
  excluded; |impact| ordering; top-N cap.
- ecs_task deriver: values unchanged after the constant-source swap (existing tests keep
  passing — they pin the formula).
- Full `npm test` + `tsc` + build + `pytest scripts/v2/workers`; gap-audit ticks with a
  batch-30 note; CHANGELOG EN/KO; component counts 104 → 105 (README ×4,
  web/components/CLAUDE.md); docs-site guides in 4 locales.
