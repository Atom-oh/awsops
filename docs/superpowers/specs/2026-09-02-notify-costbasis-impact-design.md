# Compliance completion mail, ECS cost basis panel, cost impact estimation — 3 gap-audit items (L192, L194, L225)

**Status:** Batch 30, 2026-09-02 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch30`.
**WA pillar:** Operational Excellence / Cost Optimization.

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L192 (compliance completion SNS
email), L194 (container-cost Cost Calculation Basis panel), L225 (inventory-home Cost Impact
Estimation panel).

## Decisions
- **L192** (as amended by round 1) — `compliance.notify_completed(...)`: best-effort SNS
  publish ONLY after a benchmark run SUCCESSFULLY persists (benchmark name, scope,
  total/alarm/ok, rounded pass-rate, `/compliance` link). **Subject is pinned ASCII** — SNS
  rejects a non-ASCII Subject (the diagnosis `_SUBJECT` precedent; tests assert `isascii()`),
  Korean lives in the body. Publishes via the governed `diagnosis/notify._client` path.
  Reuses the EXISTING notify plumbing end-to-end: the same `DIAGNOSIS_SNS_TOPIC_ARN` env +
  topic + `sns:Publish` grant (ZERO Terraform change — flag off ⇒ env absent ⇒ silent no-op)
  and the same `diagnosis_notify_paused` admin pause (paused ⇒ skip; pause-read failure fails
  OPEN, the digest precedent). **Flood guard**: runs are user-triggerable, so a 60-minute
  per-benchmark dedup window (on `compliance_runs.notified_at`) blocks re-blasts — the
  per-report instant mail the digest retired is not reintroduced unbounded. **Durable
  delivery record**: every path writes `compliance_runs.notify_outcome` (the ADR-013
  diagnosis vocabulary + `skipped_dedup`; a new ULID migration also re-projects
  `sql_reader.compliance_runs`). Recorded as a dated **ADR-013 amendment + BASELINE row
  update in this PR** (the third message class on the sole LIVE external-write channel).
  NEVER raises; failures print and record `publish_failed`.
- **L194** — the ECS Tasks inventory page (v2's container-cost surface — it already carries
  the daily-cost-total KPI tile and the Daily $ bar) gains a collapsible `EcsCostBasisPanel` (the
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
- **L225** (as amended by round 1) — the home dashboard gains a "월 비용 영향 추정" list:
  30-day count delta per type × a STATIC monthly-unit-cost heuristic
  (`web/lib/cost-impact.ts`), `±$N/mo est.` sorted by |impact| (top 8). Data source is a
  DEDICATED fixed `?days=35` trend fetch (the default chart fetch is 14d — without this the
  30d baseline never exists and the panel is invisible on the default view), computed over
  ALL trend types rather than the delta table's presentation-filtered rows (a type that went
  to zero >7d ago is precisely the biggest genuine saving). Honest bounds: the netChange
  stale-latest guard (a sync that died days ago must not be priced as a 30d delta), the net7
  default-scope gate (trend history is host-account-only — a narrowed scope must not show
  host-wide dollars), no-baseline/no-weight types excluded (never a fabricated $0), and an
  explicit not-billing-data disclaimer. Pure client; inline dashboard section.

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

## Round-1 corrections (review-driven)

- **ASCII SNS Subject (the CRITICAL)** — the Korean Subject violated the repo's own
  documented constraint (diagnosis `notify._SUBJECT`: "a non-ASCII Subject is rejected by
  SNS → publish fails → no email"), making the whole feature a silent no-op behind the
  best-effort catch. Subject pinned English/ASCII; tests assert `isascii()` and ≤100 chars;
  the fake SNS now captures Subject.
- **Per-benchmark 60-minute dedup window + durable notify_outcome (the mail-blast MAJOR)** —
  `POST /api/compliance/run` is non-admin user-triggerable, and per-run mail reintroduced the
  exact pattern the diagnosis digest retired. New migration adds
  `compliance_runs.notified_at/notify_outcome` (CHECK vocabulary = diagnosis + skipped_dedup,
  `sql_reader.compliance_runs` re-projected in lockstep); every notify path records an
  outcome; publish goes through `diagnosis/notify._client` (the governed path).
- **Dedicated 35d baseline fetch + honest gates (the invisible-panel MAJOR)** — the impact
  list no longer derives from the 14d-default chart fetch nor from the delta table's
  presentation-filtered rows; stale-latest and default-scope gates added (netChange/net7
  precedents), fully-removed types now contribute their savings.
- **ADR-013 amendment + BASELINE row (the L5 MAJOR)** — dated 2026-09-02 amendment records
  the third message class, worker-only publish, dedup window, shared pause, durable record.
- Minors: rounded pass rate in the mail body; docs say "successfully completes" and mention
  the 60-minute dedup (4 locales); ai-diagnosis.md notes the pause switch/subscribers also
  govern compliance mail (4 locales); ecs-container-cost guide's dangling KO/JA clauses and
  the caution headings fixed, "cost KPI tiles" → the actual single daily-cost-total tile;
  ASCII minus sign in the impact rows; Card subtitle double-tt removed.
