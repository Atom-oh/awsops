# Trace-level Topology — Implementation Plan (TDD)

Source spec: `docs/superpowers/specs/2026-06-25-trace-topology-design.md`.
Each task: write the failing test first → minimal code → refactor → commit (explicit paths).
All work is buildable/testable WITHOUT live traces (the no-op path is part of the design).

## Files in scope
- `web/lib/trace-source.ts` (new) — `TraceSpan`/`TraceSource` types + `ClickHouseOtelTraceSource`.
- `web/lib/trace-source.test.ts` (new)
- `web/lib/graph-store.ts` — add `rebuildTraceGraph` (+ bridge-ref helpers).
- `web/lib/graph-store.test.ts` — add trace-graph tests (or new `graph-store-trace.test.ts`).
- `scripts/v2/graph-rebuild.mjs` — call `rebuildTraceGraph`.
- `web/app/api/graph/route.ts` — accept/validate `class=trace` (likely already generic; add guard + test).
- `web/app/api/graph/route.test.ts` — class=trace case.
- `agent/lambda/inventory_read_mcp.py` — `get_topology` accepts `class=trace` (if it pins class).
- `agent/lambda/test_inventory_read_mcp.py` — class=trace case.
- topology page component (the `class` toggle) — add `trace`; locate exact file in Task 7.

## Tasks

- [ ] **T1 — `TraceSource` interface + types.** New `web/lib/trace-source.ts`: export `TraceSpan`
  and `TraceSource` (`available()`, `recentSpans(windowMins, cap)`). Add a `FakeTraceSource`
  test helper. Test (`web/lib/trace-source.test.ts`): the fake satisfies the contract
  (available true/false, returns the seeded spans). No graph logic yet.

- [ ] **T2 — `rebuildTraceGraph` aggregation (the core).** In `web/lib/graph-store.ts` add
  `rebuildTraceGraph(pool, source)`. Test FIRST with a `FakeTraceSource` of fixture spans
  (svc A → svc B → db postgres, with k8s attrs): assert it produces `service`/`db`/`workload`
  nodes (correct ids) + `calls`/`queries`/`runs_on` edges + `confidence` from span counts.
  Implement aggregation + mark-sweep upsert with `class='trace'`. Reuse the existing
  mark-sweep helper used by `rebuildGraph`/`rebuildInfraGraph` (no rule duplication).

- [ ] **T3 — no-op-when-empty path.** Test: `source.available()===false` → `rebuildTraceGraph`
  returns `{nodes:0,edges:0}`, throws nothing, and mark-sweeps away any stale `class='trace'`
  rows WITHOUT touching `flow`/`infra` rows (class-isolation regression assertion). Implement
  the early-return + ensure the sweep is class-scoped.

- [ ] **T4 — bridge-ref matching.** Test: given infra nodes (an RDS node with host H) + a trace
  `db` node whose host resolves to H → the `db` node gets `meta.infra_ref = <rds node id>`;
  an unmatched host → no `infra_ref` (node still present). Same shape for `workload.eks_ref`/
  `tg_ref` (best-effort; unresolved → omitted). Implement the matcher (pure function, unit-tested
  on inputs — no DB).

- [ ] **T5 — `ClickHouseOtelTraceSource` adapter.** Test: a fixture ClickHouse `otel_traces`
  response → correct `TraceSpan[]` mapping (service, kind, db.system, k8s.* attrs, timings);
  `available()` false when no ClickHouse datasource / `otel_traces` absent. Implement using the
  existing connector/datasource path (read-only SELECT, SSRF-guarded credential reuse). Bounded
  by `recentSpans(window, cap)`.

- [ ] **T6 — wire into `graph-rebuild.mjs`.** Add the `rebuildTraceGraph` call after flow/infra
  (constructing the default `ClickHouseOtelTraceSource`); log `trace: N nodes, M edges`. Test:
  the runner invokes all three rebuilds (extend the existing runner test if present, else a
  focused assertion).

- [ ] **T7 — expose `class='trace'` on the read paths + UI toggle.** (a) `/api/graph` accept +
  validate `class=trace` (+ route test). (b) `get_topology` in `inventory_read_mcp.py` accept
  `class=trace` if it pins class (+ python test). (c) Locate the topology page's class toggle
  component and add a `trace` ("Service / Traces") option (additive; test if the page has one).
  Each sub-part is its own commit if they touch independent files.

- [ ] **T8 — docs.** Update root `CLAUDE.md` Key Files + the `docs/.../reference` topology note to
  mention the `trace` layer (one-liner each). Run `/co-agent sync-context` is a follow-up, not here.

## Verification
- `cd web && npx vitest run` green for all new/changed web tests.
- `cd agent && python3 -m pytest test_inventory_read_mcp.py -q` green.
- `next build` compiles (no app-level type error).
- Manual: `rebuildTraceGraph` with an empty source is a clean no-op; `/api/graph?class=trace`
  returns an empty graph (until traces exist).

## Out of scope (per spec YAGNI)
Datadog adapter (interface only), otel collector/pipeline work, pod-granularity beyond k8s attrs,
topology UI redesign beyond the toggle option.
