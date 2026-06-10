# AWSops v2 — Gap Wave-1 Implementation Plan (code-only)

> Source: `docs/v1-v2-gap-audit-2026-06-10.md` (26-agent gap audit). Recon: 8-agent `wave1-recon`.
> **Scope discipline:** code-only. **No** `terraform apply`, **no** AWS deploy, **no** shared-infra mutation.
> Branch `worktree-gap-impl-wave1` (worktree, based on v2 HEAD `96f5a99`). All work TDD + Tidy First, one commit per task, `web` vitest green after every task.

## Goal
Close the highest-value, **code-only** Wave-1 gaps from the audit: activate the already-deployed agent fleet (gated off), restore Lambda EOL signalling, Cost MoM/forecast, a Bedrock token-cost dashboard, EKS node resource viz, an infra topology graph, structured inventory detail, and an i18n (KO/EN) toggle.

## Non-goals (out of Wave-1)
- Any `terraform apply` / AgentCore provision / ECS deploy (the fleet Lambdas/gateways are already *defined*; activation here is the `active` flag only — live responses depend on a separate deploy).
- Full v1 feature parity for large surfaces: report-generation domain, full 1501-line i18n catalog, K8s topology map, multi-account scoping, container-cost, event-scaling. (Future waves.)
- v1 `src/` is untouched (its 7 pre-existing `alert-knowledge` vitest failures are out of scope).

## Conventions (CLAUDE.md v2)
- Root path: client fetches `/api/*` (no `/awsops` prefix).
- thin-BFF: heavy logic in `web/lib/*` pure functions (unit-tested); routes only orchestrate.
- All pages `export default`, `'use client'` where they use hooks/fetch.
- Pure-function-first TDD: extract the logic into `web/lib`, unit-test in vitest (`lib/**/*.test.ts` node env; `components/**/*.test.tsx` needs `// @vitest-environment jsdom`).
- Test gate after each task: `cd web && npx vitest run` must stay green (baseline: 355 passed / 1 skipped).

## Allowed file set
The union of every task's `Create/Modify/Test` paths below is the scope-lock set. Nothing outside it may be touched.

---

### Task 1: Activate monitoring / cost / data section gateways

Flip the three already-deployed-but-gated sections to `active:true`. The gateways, targets, and Lambdas already exist in `catalog.py`/`ai.tf`; the **only** thing blocking the chat path is the `active` flag. Routing/classifier need no change.

**Files:**
- Modify: `web/lib/sections.ts`
- Test: `web/lib/sections.test.ts`
- Test: `web/lib/route.test.ts`
- Test: `web/app/api/chat/route.test.ts`

- [ ] **Step 1 (RED):** In `web/lib/sections.test.ts` (~L10-12) change the active-set assertion to the sorted set `['cost','data','monitoring','network','security']`. Run `cd web && npx vitest run lib/sections.test.ts` → fails.
- [ ] **Step 2 (GREEN):** In `web/lib/sections.ts` set `active: true` on the `data` (L24), `cost` (L36), `monitoring` (L42) objects only. **Do not reorder the SECTIONS array** (`route.ts` `ACTIVE_FALLBACK = activeSections()[0]` must stay `network`). Touch nothing else on those objects.
- [ ] **Step 3:** Update the two test files that used `data` as an *inactive* example so the P3-guard contract is still tested via a still-inactive section (`container`/`iac`/`ops`/`observability`): `web/lib/route.test.ts` (multi-match ~L64-76; valid-but-inactive pin ~L100-102; keep the `ACTIVE_FALLBACK==='network'` assertion) and `web/app/api/chat/route.test.ts` (inactive short-circuit ~L158-174 and inactive-guidance ~L258-270 — swap the `data` primary for `container`; keep the `'P3'` string assertion).
- [ ] **Step 4 (verify+commit):** `cd web && npx vitest run` fully green (incl. `golden-routing.test.ts`, `classifier.test.ts` regressions). Then `git add web/lib/sections.ts web/lib/sections.test.ts web/lib/route.test.ts web/app/api/chat/route.test.ts && git commit -m "feat(v2-gap-w1): activate monitoring/cost/data section gateways (flag-only; fleet already deployed)"`

---

### Task 2: Lambda EOL runtime badge in inventory

Add a deprecated-runtime signal to the generic inventory table (v1 had it on its dedicated Lambda page). Pure predicate + one `renderCell` branch.

**Files:**
- Modify: `web/lib/inventory-types.ts`
- Test: `web/lib/inventory-types.test.ts`
- Modify: `web/components/ui/DataTable.tsx`
- Test: `web/components/ui/datatable-render.test.tsx`

- [ ] **Step 1 (RED):** In `web/lib/inventory-types.test.ts` add a describe for `isDeprecatedRuntime`: deprecated (`python3.7`,`nodejs14.x`,`go1.x` → true), current (`python3.12`,`nodejs20.x` → false), normalization (`' Python3.7 '` → true), `null`/`''`/`undefined`/`'custom'` → false. Run → fails (fn missing).
- [ ] **Step 2 (GREEN):** In `web/lib/inventory-types.ts` export `DEPRECATED_RUNTIMES` (v1's 12: `python2.7,python3.6,python3.7,nodejs10.x,nodejs12.x,nodejs14.x,dotnetcore2.1,dotnetcore3.1,ruby2.5,ruby2.7,java8,go1.x`) and `isDeprecatedRuntime(runtime: unknown): boolean` (normalize `String(runtime).trim().toLowerCase()`, false on empty/null).
- [ ] **Step 3:** In `web/components/ui/DataTable.tsx` `renderCell` (~L15) add: when `key==='runtime' && isDeprecatedRuntime(value)`, render the runtime text plus `<Badge tone="negative" variant="soft">EOL</Badge>`. Keep the default truncate span otherwise. Import `isDeprecatedRuntime` from `@/lib/inventory-types`.
- [ ] **Step 4 (verify+commit):** Add `web/components/ui/datatable-render.test.tsx` (`// @vitest-environment jsdom`): a row with `runtime:'nodejs14.x'` shows `EOL`, `runtime:'nodejs20.x'` does not. `cd web && npx vitest run` green. `git add web/lib/inventory-types.ts web/lib/inventory-types.test.ts web/components/ui/DataTable.tsx web/components/ui/datatable-render.test.tsx && git commit -m "feat(v2-gap-w1): Lambda EOL runtime badge in inventory table (pure isDeprecatedRuntime + DataTable cell)"`

---

### Task 3: Structured inventory DetailPanel (grouped, typed rendering)

Lift the flat key/value DetailPanel into grouped/typed rendering driven by the type spec, fully backward-compatible when no spec is passed.

**Files:**
- Create: `web/lib/inventory-detail.ts`
- Test: `web/lib/inventory-detail.test.ts`
- Modify: `web/lib/inventory-types.ts`
- Modify: `web/components/ui/DetailPanel.tsx`
- Modify: `web/app/inventory/[type]/page.tsx`
- Test: `web/components/ui/detailpanel.test.tsx`

- [ ] **Step 1 (RED):** `web/lib/inventory-detail.test.ts` for `formatDetailValue(key,value)` (boolean→badge, null/''→empty, object→code, state-key→state, number/string→text) and `buildDetailGroups(row, spec?)` (spec → labelled, ordered, sectioned groups + an `Other` group for unknown keys; no spec → single flat group). Run → fails.
- [ ] **Step 2 (GREEN):** Create `web/lib/inventory-detail.ts` with those two pure fns (reuse the `STATE_KEYS` notion from `DataTable.tsx`). Add optional `sections?: { label: string; keys: string[] }[]` to `InvType` in `web/lib/inventory-types.ts` and populate it for `ec2` and `rds` only.
- [ ] **Step 3:** `web/components/ui/DetailPanel.tsx`: add optional `spec?: InvType` prop; render via `buildDetailGroups`/`formatDetailValue` (state→`StatePill`, badge→`Badge`, code→`<pre>`). When `spec` is undefined keep the exact current flat behaviour. Pass `spec={spec}` from `web/app/inventory/[type]/page.tsx` (~L196-200).
- [ ] **Step 4 (verify+commit):** Extend `web/components/ui/detailpanel.test.tsx` (jsdom): with a spec → section headers + labels render; without spec → existing flat cases still pass. `cd web && npx vitest run` green. `git add web/lib/inventory-detail.ts web/lib/inventory-detail.test.ts web/lib/inventory-types.ts web/components/ui/DetailPanel.tsx web/app/inventory/[type]/page.tsx web/components/ui/detailpanel.test.tsx && git commit -m "feat(v2-gap-w1): structured grouped DetailPanel (spec-driven, backward-compatible)"`

---

### Task 4: Cost — MoM trend + month-end forecast

Add month-over-month % and projected month-end to the cost page; pure math in `web/lib/cost.ts`, CE calls in `aws.ts`, graceful-degrade merge in the route.

**Files:**
- Create: `web/lib/cost.ts`
- Test: `web/lib/cost.test.ts`
- Modify: `web/lib/aws.ts`
- Test: `web/lib/aws.test.ts`
- Modify: `web/app/api/cost/route.ts`
- Test: `web/app/api/cost/route.test.ts`
- Modify: `web/app/cost/page.tsx`

- [ ] **Step 1 (RED+GREEN):** `web/lib/cost.test.ts` + `web/lib/cost.ts`: `momChangePct(thisMonth,lastMonth)` (lastMonth=0 → 0; signed %), `projectMonthEnd(mtd, now)` (now **injected** for determinism: `(mtd / dayOfMonth) * daysInMonth`; handle last day, Feb/leap). Port v1 formulas (`src/app/cost/page.tsx:166-174`). Run → green.
- [ ] **Step 2:** `web/lib/aws.ts`: add `getMonthlyCost(months=6)` (GetCostAndUsage `Granularity:'MONTHLY'` GroupBy SERVICE → `[{month,total,byService?}]`) and `getCostForecast()` (`GetCostForecastCommand` to month-end). Extend `web/lib/aws.test.ts` mock (`ceSend`) with `GetCostForecastCommand` + mapping assertions.
- [ ] **Step 3 (GATE FIX — CRITICAL):** `web/app/api/cost/route.ts`: merge `getMonthlyCost()`/`getCostForecast()` each behind `.catch(()=>fallback)` (same degrade pattern as the existing `trend`), returning `{...mtd, trend, monthly, forecast}`. **You MUST also update `web/app/api/cost/route.test.ts`** — its `vi.mock('@/lib/aws', …)` currently exports ONLY `getMtdCost`+`getCostTrend`; add `getMonthlyCost`+`getCostForecast` to the mock (+ `mockReset` in `beforeEach`), add assertions that both degrade to fallback on rejection, and that the 200 body carries `monthly`/`forecast`. Without this the existing green cost route test breaks (the new symbols are undefined in the mock).
- [ ] **Step 4 (verify+commit):** `web/app/cost/page.tsx`: consume `monthly`/`forecast` — add a MoM% `StatTile` (trend pin) + month-end-forecast `StatTile` + one monthly `AreaTrend` (reuse `web/components/charts/`). `cd web && npx vitest run` green. `git add web/lib/cost.ts web/lib/cost.test.ts web/lib/aws.ts web/lib/aws.test.ts web/app/api/cost/route.ts web/app/api/cost/route.test.ts web/app/cost/page.tsx && git commit -m "feat(v2-gap-w1): cost MoM % + month-end forecast (pure cost.ts + CE monthly/forecast, graceful-degrade)"`

---

### Task 5: EKS node resource visualization

Surface node CPU/memory capacity vs requested. Pure parsers + aggregator in `eks-incluster.ts`, bars on the nodes tab.

**Files:**
- Modify: `web/lib/eks-incluster.ts`
- Test: `web/lib/eks-incluster.test.ts`
- Modify: `web/app/eks/[cluster]/page.tsx`

- [ ] **Step 1 (RED):** `web/lib/eks-incluster.test.ts`: `parseCpuCores` (`'8'`→8, `'7910m'`→7.91, `''`→0), `parseMem` (Ki/Mi/Gi/Ti → bytes, per v1 `src/app/k8s/nodes/page.tsx:72-83`), `normalizeNode` maps `status.capacity/allocatable`, `normalizePod` carries per-pod cpu/mem requests, `aggregateNodeResources(nodes,pods)` → per-node `{cpuReq,memReq,podCount,reqPct}`. Run → fails.
- [ ] **Step 2 (GREEN — GATE FIX MAJOR):** `web/lib/eks-incluster.ts`: extend `K8sItem` with `status.capacity/allocatable` (`Record<string,string>`) and `spec.containers[].resources.requests`. **Extend BOTH row types** (current `NodeRow = {name,status,roles,version,instanceType,zone,age}`, `PodRow = {name,namespace,status,node,restarts,age}` carry NO resource fields): add `cpuCapacity/cpuAllocatable/memCapacity/memAllocatable` to `NodeRow` (fill in `normalizeNode`) AND `cpuRequest/memRequest` to `PodRow` (fill in `normalizePod` by summing `spec.containers[].resources.requests` — currently dropped). Export `parseCpuCores`, `parseMem`, `aggregateNodeResources`. (Without PodRow carrying requests the client cannot aggregate — flagged by 2 panel models.)
- [ ] **Step 3:** `web/app/eks/[cluster]/page.tsx`: on the nodes tab fetch BOTH `/api/eks/${cluster}/incluster?kind=nodes` and `?kind=pods` (exact endpoint — returns `{kind, rows}`), call `aggregateNodeResources(nodeRows, podRows)`, render per-node CPU/memory used-vs-capacity bars (reuse a `Meter`/segmented bar with existing design tokens). Root-path `/api/*` only.
- [ ] **Step 4 (verify+commit):** `cd web && npx vitest run` green. `git add web/lib/eks-incluster.ts web/lib/eks-incluster.test.ts web/app/eks/[cluster]/page.tsx && git commit -m "feat(v2-gap-w1): EKS node CPU/mem capacity-vs-requested viz (pure parsers + aggregate)"`

---

### Task 6: Bedrock token-cost monitoring dashboard

New page + thin-BFF route reading AWS/Bedrock CloudWatch metrics; pure pricing/aggregation in `web/lib/bedrock.ts`.

**Files:**
- Create: `web/lib/bedrock.ts`
- Test: `web/lib/bedrock.test.ts`
- Modify: `web/lib/metrics.ts`
- Test: `web/lib/metrics.test.ts`
- Create: `web/app/api/bedrock-metrics/route.ts`
- Create: `web/app/bedrock/page.tsx`
- Modify: `web/components/shell/Sidebar.tsx`
- Modify: `web/components/shell/CommandPalette.tsx`

- [ ] **Step 1 (RED+GREEN):** `web/lib/bedrock.test.ts` + `web/lib/bedrock.ts`: `MODEL_PRICING` (port v1 `src/app/api/bedrock-metrics/route.ts:20-44`), `getModelLabel`, `getModelPricing` (normalize cross-region `us./eu./ap./global.` prefixes; haiku/opus/default fallback), `RANGE_CONFIGS` (1h–30d), `computeCost` (input/output/cacheRead/cacheWrite + `cacheSavings`), and the per-model aggregation reducer. Run → green.
- [ ] **Step 2 (GATE FIX MAJOR):** `web/lib/metrics.ts`: add `bedrockModelMetrics()` reusing the `cwClient()` singleton. **Discover active models with `ListMetricsCommand`** (namespace `AWS/Bedrock`, enumerate the `ModelId` dimension values) — `GetMetricDataCommand` alone cannot enumerate dimension values — then `GetMetricDataCommand` per model for invocations/tokens/latency/errors/cache tokens. Extend `web/lib/metrics.test.ts` (`cwSend` mock) with a `ListMetrics`→`GetMetricData` mapping case.
- [ ] **Step 3:** Create `web/app/api/bedrock-metrics/route.ts` — `export const dynamic='force-dynamic'`, `verifyUser` 401 guard (mirror `web/app/api/cost/route.ts:6-9`), parse `range`, combine `bedrockModelMetrics()` + `bedrock.ts`, standard error frame.
- [ ] **Step 4:** Create `web/app/bedrock/page.tsx` (`'use client'`, fetch `/api/bedrock-metrics?range=…` root path) — KPI `StatTile`s + per-model `DataTable` + cost `Donut` + invocations `Bar` + tokens `AreaTrend` (reuse `web/components/charts/`). Register nav: `web/components/shell/Sidebar.tsx` FIXED array (`Sparkles` already imported) + `web/components/shell/CommandPalette.tsx` `buildCommands` fixed array.
- [ ] **Step 5 (verify+commit):** `cd web && npx vitest run` green. `git add web/lib/bedrock.ts web/lib/bedrock.test.ts web/lib/metrics.ts web/lib/metrics.test.ts web/app/api/bedrock-metrics/route.ts web/app/bedrock/page.tsx web/components/shell/Sidebar.tsx web/components/shell/CommandPalette.tsx && git commit -m "feat(v2-gap-w1): Bedrock token-cost dashboard (CloudWatch metrics + pure pricing/aggregation + nav)"`

---

### Task 7: Infra topology graph (inventory-based, MVP)

Static infra graph from already-synced inventory. Pure builder in `web/lib/topology.ts`; ReactFlow page.

**Files:**
- Create: `web/lib/topology.ts`
- Test: `web/lib/topology.test.ts`
- Create: `web/app/topology/page.tsx`
- Modify: `web/components/shell/Sidebar.tsx`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`

- [ ] **Step 1 (RED+GREEN):** `web/lib/topology.test.ts` + `web/lib/topology.ts`: `buildTopology({vpc,subnet,ec2,rds,alb,security_group})` → `{nodes,edges}` (reactflow-independent types). Port v1 `src/app/topology/page.tsx:112-233` hierarchy: subnet.vpc_id→VPC edge; ec2.subnet_id→Subnet (fallback vpc_id→VPC); rds/alb.vpc_id→VPC. Fixtures cover node counts, parent edges, orphan fallback, empty input `{nodes:[],edges:[]}`, dedup. Run → green.
- [ ] **Step 2:** Add dep: `cd web && npm install @xyflow/react` (updates `web/package.json` + `web/package-lock.json`).
- [ ] **Step 3 (GATE FIX MAJOR):** Create `web/app/topology/page.tsx` (`'use client'`): parallel-fetch `/api/inventory/{vpc,subnet,ec2,rds,alb}?limit=500` (root path — the inventory route defaults to **100 rows, max 500**, so pass `?limit=500` or the graph silently omits resources; `log` a note if any type returns 500). `map(x=>({resource_id,region,...x.data}))`, `buildTopology`, render via `next/dynamic` `ssr:false` ReactFlow + Background/Controls/MiniMap/fitView + `PageHeader`. **Import `@xyflow/react/dist/style.css`** (ReactFlow renders blank without it). Add `web/components/shell/Sidebar.tsx` FIXED entry `{href:'/topology',label:'Topology',icon:Network}` (`Network` already imported).
- [ ] **Step 4 (verify+commit):** `cd web && npx vitest run` green AND `npx next build` succeeds (new client page + dynamic ReactFlow import must build cleanly — flagged by panel; do not skip the build for new pages). `git add web/lib/topology.ts web/lib/topology.test.ts web/app/topology/page.tsx web/components/shell/Sidebar.tsx web/package.json web/package-lock.json && git commit -m "feat(v2-gap-w1): infra topology graph (pure builder + @xyflow/react page, inventory-based MVP)"`

---

### Task 8: i18n KO/EN toggle (shell/nav MVP)

Lightweight i18n for shell/nav text + a persistent toggle. Keys the final nav set (incl. Bedrock + Topology from tasks 6–7).

**Files:**
- Create: `web/lib/i18n.ts`
- Test: `web/lib/i18n.test.ts`
- Create: `web/components/shell/LanguageProvider.tsx`
- Create: `web/components/shell/LanguageToggle.tsx`
- Modify: `web/app/layout.tsx`
- Modify: `web/components/shell/Sidebar.tsx`
- Modify: `web/components/shell/CommandPalette.tsx`

- [ ] **Step 1 (RED+GREEN):** `web/lib/i18n.test.ts` + `web/lib/i18n.ts`: `Lang='ko'|'en'`, inline `messages` dict (shell/nav keys only, ~20), pure `translate(lang,key,params?)`/`makeT(lang)` — ko/en lookup, missing→en fallback→key, `{param}` interpolation, **ko/en keyset parity** guard. node-env test. Run → green.
- [ ] **Step 2:** Create `web/components/shell/LanguageProvider.tsx` (`'use client'` Context + `useI18n()`; `useState<Lang>('ko')`, load/save `localStorage 'awsops-lang'`, set `document.documentElement.lang`; SSR-safe initial `ko`) and `web/components/shell/LanguageToggle.tsx` (EN/한 button, port v1 `src/components/layout/Sidebar.tsx:272-278`).
- [ ] **Step 3:** Wrap `web/app/layout.tsx` shell with `LanguageProvider`. Key `web/components/shell/Sidebar.tsx` (footer admin/sign-out/online + FIXED nav labels incl. Bedrock/Topology) and `web/components/shell/CommandPalette.tsx` (placeholder/noResults/aria-label/hint) via `useI18n()`; add `LanguageToggle` to the sidebar footer. `buildCommands` gains a `lang` dependency.
- [ ] **Step 4 (verify+commit):** `cd web && npx vitest run` green. `git add web/lib/i18n.ts web/lib/i18n.test.ts web/components/shell/LanguageProvider.tsx web/components/shell/LanguageToggle.tsx web/app/layout.tsx web/components/shell/Sidebar.tsx web/components/shell/CommandPalette.tsx && git commit -m "feat(v2-gap-w1): i18n KO/EN toggle for shell/nav (pure i18n.ts + provider + toggle)"`

---

## Done criteria
- All 8 tasks committed; `cd web && npx vitest run` green (≥ 355 + new tests, 0 failures).
- `cd web && npx next build` succeeds (new pages `bedrock`, `topology` build cleanly — panel-mandated for new Next pages).
- No file touched outside the allowed set; no `terraform apply` / deploy performed.
- Final cumulative diff passes the P4 multi-model consensus gate.
- PR opened from `worktree-gap-impl-wave1` (does not auto-merge).

## P2 gate record (round 1)
5/5 panel pairs usable (opus, gpt-5.5, gemini, kimi-k2.5, glm-5). gemini + kimi-k2.5 → `[]` (sound). Verified CRITICAL/MAJOR addressed by this revision:
- **CRITICAL** (opus, codex): cost route test mock missing new symbols → added `web/app/api/cost/route.test.ts` to scope + mock-update step (Task 4 Step 3).
- **MAJOR** (codex, glm): `PodRow`/`NodeRow` lack resource fields → Task 5 now extends both + exact pods endpoint.
- **MAJOR** (codex): Bedrock model discovery needs `ListMetrics` → Task 6 Step 2 explicit.
- **MAJOR** (codex): inventory `limit=100` truncates topology → Task 7 `?limit=500` + reactflow CSS import.
- **MAJOR** (codex): new Next pages must `next build` → added to Task 7 Step 4 + Done criteria.
- Dismissed: glm "InvType lacks `sections`" (Task 3 *adds* it — misread); line-anchor nits (plan anchors are `~`approximate, locate by content).
