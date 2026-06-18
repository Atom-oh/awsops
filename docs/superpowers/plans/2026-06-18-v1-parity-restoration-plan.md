# Plan — v1-parity restoration (TDD)

> Spec: `docs/superpowers/specs/2026-06-18-v1-parity-restoration-design.md`.
> Branch `feat/v2-parity` (worktree, base = `origin/feat/v2-architecture-design`).
> Read-only feature work. Each task: failing test → minimal impl → test green → single commit (explicit paths).
> Do NOT touch `scripts/v2/workers/diagnosis/sources.py` / `test_sources.py` (concurrent A-data branch).

## Out of scope
Diagnosis collectors (`sources.py`); reverting #63 agent routing; AWS-resource mutation / autonomy / ADR-frozen
substrate; new connector kinds; AWS-resource SQL console.

---

### Task 1: WS-C rdsMetrics in the metrics lib

**Files:**
- Create: `web/lib/metrics.test.ts`
- Modify: `web/lib/metrics.ts`

- [ ] Failing test: `rdsMetrics(['db-1','db-2'], accountId)` with a mocked CloudWatch `GetMetricData` returns
      `{ byInstance: { 'db-1': {cpu, freeableMemory, connections, readIops, writeIops, freeStorage, netIn, netOut} }, avgCpu }`;
      empty instance list → empty result (no CW call); CW denial → degrades to nulls (never throws).
- [ ] Implement: `GetMetricDataCommand`, namespace `AWS/RDS`, dim `DBInstanceIdentifier`, 8 metrics, ~3h/avg,
      reuse the `assumedClient(accountId)` multi-account path mirroring `ec2AvgCpu`. Read-only, no persist.
- [ ] Run `cd web && npx vitest run lib/metrics.test.ts`.
- [ ] Commit: `feat(metrics): rdsMetrics — 8 CloudWatch AWS/RDS series per DBInstanceIdentifier (read-only)`.

### Task 2: WS-C RDS branch in the inventory metrics route

**Files:**
- Modify: `web/app/api/inventory/[type]/metrics/route.ts`
- Test: `web/app/api/inventory/[type]/metrics/route.test.ts`

- [ ] Failing test: `type='rds'` returns metric `cards` (avg CPU %, connections, free storage GB) derived from
      `rdsMetrics`; `type='ec2'` path unchanged; an unknown type still returns `{cards:[]}`.
- [ ] Implement: add the `rds` branch (resolve instance ids from inventory like EC2, call `rdsMetrics`, build cards).
- [ ] Run `cd web && npx vitest run 'app/api/inventory/[type]/metrics/route.test.ts'`.
- [ ] Commit: `feat(inventory): RDS metric cards (CPU/connections/free-storage) via /metrics route`.

### Task 3: WS-C per-instance RDS metrics table in the detail panel

**Files:**
- Modify: `web/components/ui/DetailPanel.tsx`
- Test: `web/components/ui/DetailPanel.test.tsx`

- [ ] Failing test: opening a `resource_type='rds'` row renders an "Instance Metrics" table with the 8 metric
      labels and live values (mock the fetch); a non-rds row renders no metrics table; a CW-degraded fetch shows a
      graceful "메트릭 불가" note, not an error.
- [ ] Implement: when the opened row is rds, fetch per-instance metrics (resource_id=DBInstanceIdentifier) and
      render the table; keep existing raw-field rendering for all types.
- [ ] Run `cd web && npx vitest run components/ui/DetailPanel.test.tsx`.
- [ ] Commit: `feat(inventory): RDS detail panel renders an 8-metric CloudWatch table (v1 parity)`.

### Task 4: WS-D language-aware NL→query prompt

**Files:**
- Modify: `web/app/api/datasources/generate/route.ts`
- Test: `web/app/api/datasources/generate/route.test.ts`

- [ ] Failing test: the system prompt for `prometheus` contains PromQL guidance tokens (e.g. `rate(`, `sum by`,
      `[5m]`); `loki` contains LogQL tokens (`count_over_time`, `|~`); `clickhouse` keeps the read-only SELECT rule;
      an empty cached schema yields a "no real names — refresh schema" instruction. Existing 401/400/413/502 intact.
- [ ] Implement: replace `queryOnlyPrompt(lang)` with per-language guidance + 2–3 examples each; add the
      schema-empty instruction. NO change to the agent-routing (flagged separately).
- [ ] Run `cd web && npx vitest run app/api/datasources/generate/route.test.ts`.
- [ ] Commit: `fix(datasource): PromQL/LogQL/TraceQL-aware NL→query prompt (stops nonsensical queries)`.

### Task 5: WS-A WADD-depth section prompts

**Files:**
- Modify: `scripts/v2/workers/diagnosis/sections.py`
- Create: `scripts/v2/workers/diagnosis/test_sections_wadd.py`

- [ ] Failing tests: each base section's prompt is "deep" (persona + a prescribed markdown table + severity tokens
      Critical/Warning + priority P1/P2/P3 + effort + "데이터 불가" honesty clause); pricing-benchmark tokens
      (Graviton/gp3) present in the cost/compute/storage prompts; every section still declares valid `sources`
      from the existing collector keys (no new sources). Korean-first preserved.
- [ ] Implement: rewrite the 8 base section prompts to WADD depth (adapt v1 `src/lib/report-prompts.ts`), grounded
      in v2's available collected data; keep keys/titles/sources structure (UI + report.py contract).
- [ ] Run `cd scripts/v2/workers/diagnosis && python3 -m pytest test_sections_wadd.py -q`.
- [ ] Commit: `feat(diagnosis): WADD-depth section prompts (persona+tables+severity/priority/effort+pricing)`.

### Task 6: WS-A 6-pillar Infrastructure Health Score

**Files:**
- Modify: `scripts/v2/workers/diagnosis/sections.py`
- Test: `scripts/v2/workers/diagnosis/test_sections_wadd.py`

- [ ] Failing test: the `executive_summary` prompt instructs a weighted 0–100 health score across the 6 WA pillars
      with explicit weights (Ops 15 / Sec 20 / Rel 20 / Perf 15 / Cost 20 / Sustain 10) and an interpretation band;
      it still bans fabrication.
- [ ] Implement: extend the exec-summary prompt with the scoring rubric (LLM-computed, evidence-based, matches v1).
- [ ] Run `cd scripts/v2/workers/diagnosis && python3 -m pytest test_sections_wadd.py -q`.
- [ ] Commit: `feat(diagnosis): 6-pillar Infrastructure Health Score (0-100) in executive summary`.

### Task 7: WS-A Recommendations & Roadmap synthesis

**Files:**
- Modify: `scripts/v2/workers/diagnosis/sections.py`
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Test: `scripts/v2/workers/diagnosis/test_sections_wadd.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`

- [ ] Failing test: the `recommendations` prompt requires Quick-Wins/Short-term/Medium-term tables, an
      impact×effort priority matrix, and an estimated-savings ($/mo,$/yr) rollup where cost data supports it;
      `build_markdown` still assembles TOC+sections and the +1 INTENDED_VS_ACTUAL invariant holds.
- [ ] Implement: enhance the recommendations prompt (read-only, "권고만"); any report.py change stays additive in
      `build_markdown`.
- [ ] Run `cd scripts/v2/workers/diagnosis && python3 -m pytest test_sections_wadd.py test_report.py -q`.
- [ ] Commit: `feat(diagnosis): recommendations roadmap (quick/short/medium + priority matrix + savings rollup)`.

### Task 8: WS-B diagnosis-schedule lib

**Files:**
- Create: `web/lib/diagnosis-schedule.ts`
- Create: `web/lib/diagnosis-schedule.test.ts`

- [ ] Failing tests: `computeNextRun(type, fromISO)` for weekly/biweekly/monthly returns the correct next KST
      timestamp; `readSchedule(userSub)`/`upsertSchedule(...)` shape against a mocked pool (singleton per
      user_sub+schedule_type; enabled toggles next_run_at on/off like v1 `report-scheduler.ts`).
- [ ] Implement: pure `computeNextRun` + node-pg read/upsert against `report_schedules`.
- [ ] Run `cd web && npx vitest run lib/diagnosis-schedule.test.ts`.
- [ ] Commit: `feat(diagnosis): diagnosis-schedule lib — report_schedules read/upsert + KST next-run`.

### Task 9: WS-B schedule BFF route

**Files:**
- Create: `web/app/api/diagnosis/schedule/route.ts`
- Create: `web/app/api/diagnosis/schedule/route.test.ts`

- [ ] Failing tests: GET returns the caller's schedule (or a disabled default); PUT upserts {type,enabled,tier,model}
      and recomputes next_run_at; unauthenticated → 401; invalid frequency → 400.
- [ ] Implement: authed GET/PUT calling the schedule lib.
- [ ] Run `cd web && npx vitest run app/api/diagnosis/schedule/route.test.ts`.
- [ ] Commit: `feat(diagnosis): GET/PUT /api/diagnosis/schedule (per-user auto-diagnosis schedule)`.

### Task 10: WS-B schedule dispatcher worker

**Files:**
- Create: `scripts/v2/workers/schedule_dispatcher.py`
- Create: `scripts/v2/workers/test_schedule_dispatcher.py`

- [ ] Failing tests (fake conn): due rows (`enabled AND next_run_at<=now`) each enqueue a `report` job + advance
      next_run_at; not-due rows skipped; re-running after advance does NOT double-enqueue (idempotent); a row whose
      enqueue fails does not block the others (degrade).
- [ ] Implement: scan + enqueue (reuse the worker `db`/`enqueueJob` seam) + advance next_run_at.
- [ ] Run `cd scripts/v2/workers && python3 -m pytest test_schedule_dispatcher.py -q`.
- [ ] Commit: `feat(diagnosis): schedule_dispatcher — EventBridge scan of report_schedules → enqueue (idempotent)`.

### Task 11: WS-B terraform EventBridge + dispatcher Lambda (flag-gated)

**Files:**
- Modify: `terraform/v2/foundation/workers.tf`
- Modify: `terraform/v2/foundation/variables.tf`

- [ ] Add `diagnosis_schedule_enabled` (default false). Add an hourly EventBridge rule + the dispatcher Lambda
      (arm64) + scoped IAM (read `report_schedules`, enqueue to the jobs queue), all `count`-gated on the flag.
- [ ] Verify `terraform -chdir=terraform/v2/foundation validate` passes and `plan` is a no-op with the flag off.
- [ ] Commit: `feat(diagnosis): flag-gated EventBridge+Lambda dispatcher for scheduled diagnosis (default off)`.

### Task 12: WS-B schedule UI panel

**Files:**
- Create: `web/components/diagnosis/SchedulePanel.tsx`
- Create: `web/components/diagnosis/SchedulePanel.test.tsx`
- Modify: `web/components/diagnosis/DiagnosisView.tsx`

- [ ] Failing test: the panel renders frequency select (weekly/biweekly/monthly) + enable toggle + next-run display,
      loads from GET, saves via PUT; disabled state hides next-run.
- [ ] Implement: the panel + mount it in DiagnosisView.
- [ ] Run `cd web && npx vitest run components/diagnosis/SchedulePanel.test.tsx`.
- [ ] Commit: `feat(diagnosis): schedule config panel on the diagnosis page`.

### Task 13: full sweep

**Files:**

- [ ] `cd web && npx vitest run` (web) + `python3 -m pytest scripts/v2/workers -q` (workers) +
      `terraform -chdir=terraform/v2/foundation validate`. All green.
- [ ] Commit any test-only fixups: `test: full sweep green for v1-parity restoration`.
