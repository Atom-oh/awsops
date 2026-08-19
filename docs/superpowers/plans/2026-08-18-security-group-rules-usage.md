# Security Group Rules and Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Security Group inventory, Rules, and Usage; add daily S3/Athena-compatible rule activity evidence without claiming exact rule attribution.

**Architecture:** Rule inventory and ENI membership are synchronized daily for every onboarded account/region. Admin-configured Athena sources are validated asynchronously, then mature S3 Flow Log partitions are queried once per source/day and compact compatible-rule evidence is persisted in Aurora. Rules remains table-first with compact graphs; the existing SG analysis moves unchanged to Usage and gains a bounded relationship graph.

**Tech Stack:** Next.js 14, TypeScript, node-pg, Vitest, React Flow, Dagre, Python 3.12, boto3 EC2/Athena/Glue/S3, pg8000, EventBridge, ECS Fargate, Terraform.

> **2026-08-19 validation note (Phase 0, resolved):** this plan's Task 2 premise — that
> `web/lib/sg-analysis.ts`/`SgAnalysisSection.tsx`/`web/app/api/sg/route.ts` did not exist on
> `main` — is now resolved: PR #223 merged the upstream `v2` SG-analysis baseline into `main` on
> 2026-08-18, so those three files exist and this plan's Task 2 ("move, do not duplicate") can
> proceed as written. Task 3's graph builder should sit on top of the shared `PolicyGraph` contract
> at `web/lib/policy-graph.ts` (`boundGraph`) rather than a new bounding implementation. `web/` still
> has no Playwright — Task 9's e2e checks run as a manual Playwright MCP check instead. New job
> types (`sg_rule_source_validate` lambda, `sg_rule_inventory`/`sg_rule_activity` fargate) need
> explicit packaging (Dockerfile `COPY`, `archive_file.workers_src` entries), not just a `REGISTRY`
> line, and there is currently zero Athena/Glue precedent and zero cross-account `sts:AssumeRole`
> grant on either worker role in this repo — both are new capabilities requiring IAM + likely a new
> ADR (see the approved plan's Cross-cutting section).

---

### Task 1: Add Rule Inventory, Membership, Source, and Daily Activity Tables

**Files:**
- Create: `terraform/v2/foundation/migrations/01M09YEG0QBX1FXYW3HEG8DFDB_security_group_rule_activity.sql`
- Create: `scripts/v2/migrations-sg-rule-activity.itest.mjs`

- [ ] **Step 1: Write a failing migration test**

```js
for (const table of [
  'sg_flow_sources',
  'sg_rule_inventory',
  'sg_eni_membership_history',
  'sg_rule_activity_daily',
  'sg_rule_scan_runs',
  'sg_flow_source_days',
]) {
  const found = await db.query(`SELECT to_regclass('public.${table}') AS name`);
  assert.equal(found.rows[0].name, table);
}
```

- [ ] **Step 2: Verify red**

Run: `node scripts/v2/migrations-sg-rule-activity.itest.mjs`

Expected: FAIL because the migration is absent.

- [ ] **Step 3: Add the approved schema and constraints**

Use the exact columns from the approved design. Add status CHECK constraints, positive scan budget checks, `valid_to > valid_from`, filter/retention indexes, and source uniqueness. Store ENI membership as change intervals and daily activity by rule fingerprint.

- [ ] **Step 4: Verify green**

Run: `node scripts/v2/migrations-sg-rule-activity.itest.mjs`

Expected: PASS on two applications.

- [ ] **Step 5: Commit**

```bash
git add terraform/v2/foundation/migrations/01M09YEG0QBX1FXYW3HEG8DFDB_security_group_rule_activity.sql scripts/v2/migrations-sg-rule-activity.itest.mjs
git commit -m "feat(sg-rules): add activity persistence model"
```

### Task 2: Split Security Group Navigation and Move Existing Usage

**Files:**
- Modify: `web/lib/inventory-types.ts`
- Modify: `web/lib/i18n.ts`
- Modify: `web/components/shell/Sidebar.test.tsx`
- Modify: `web/app/inventory/[type]/page.tsx`
- Create: `web/app/network/security-groups/usage/page.tsx`
- Create: `web/app/network/security-groups/usage/UsageClient.tsx`

- [ ] **Step 1: Write navigation and page tests**

```ts
expect(network.children.find((x) => x.label === 'Security Group')?.children.map((x) => x.label))
  .toEqual(['Security Groups', 'Rules', 'Usage']);
```

```tsx
expect(screen.queryByText('보안 그룹 사용 분석')).not.toBeInTheDocument();
```

- [ ] **Step 2: Verify red**

Run: `cd web && npx vitest run lib/inventory-types.test.ts components/shell/Sidebar.test.tsx`

Expected: FAIL because the subgroup and Usage route do not exist.

- [ ] **Step 3: Move, do not duplicate, the analysis UI**

Remove `SgAnalysisSection` from the inventory page and render it in `UsageClient`. Preserve existing 1h/6h/24h/7d behavior and `/api/sg` semantics. Add a Rules link filtered by selected SG.

- [ ] **Step 4: Verify green**

Run: `cd web && npx vitest run lib/inventory-types.test.ts components/shell/Sidebar.test.tsx lib/sg-analysis.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/inventory-types.ts web/lib/i18n.ts web/components/shell web/app/inventory web/app/network/security-groups/usage
git commit -m "feat(sg): split inventory and usage navigation"
```

### Task 3: Add Bounded Usage and Rule Graph Builders

**Files:**
- Reference baseline: `.superpowers/brainstorm/2026-08-18-network-security-graph-ui.html`
- Create: `web/lib/sg-policy-graph.ts`
- Create: `web/lib/sg-policy-graph.test.ts`
- Modify: `web/components/inventory/metrics/SgAnalysisSection.tsx`

- [ ] **Step 1: Write graph tests**

```ts
it('labels hits as compatible traffic and caps usage nodes', () => {
  const graph = buildUsageGraph(fixtureWith150Peers);
  expect(graph.nodes.length).toBeLessThanOrEqual(100);
  expect(graph.edges.some((e) => e.label?.includes('compatible traffic'))).toBe(true);
  expect(graph.nodes.some((n) => n.kind === 'collapsed')).toBe(true);
});
```

- [ ] **Step 2: Verify red**

Run: `cd web && npx vitest run lib/sg-policy-graph.test.ts`

Expected: FAIL because the builder is absent.

- [ ] **Step 3: Implement graph builders**

```ts
export function buildRuleGraph(input: RuleEvidence): PolicyGraphDto {
  return boundGraph({
    version: 1,
    capturedAt: input.observedAt,
    nodes: ruleNodes(input),
    edges: ruleEdges(input).map((edge) => ({ ...edge, relation: 'compatible-traffic' })),
  }, { nodes: 40, edges: 80 });
}
```

Reuse `PolicyGraph` from the Network Path feature. Usage centers the SG and shows attached, references, referenced-by, and compatible-traffic relations. Never label a traffic edge as an exact matched rule.

Convert the approved `SG Usage` tab in
`.superpowers/brainstorm/2026-08-18-network-security-graph-ui.html` into the selected-row detail
experience. Preserve the existing SG KPI cards, filters, time-range selector, and table shown in the
current product; the graph appears only after row selection and does not replace the authoritative
table.

- [ ] **Step 4: Verify green**

Run: `cd web && npx vitest run lib/sg-policy-graph.test.ts lib/sg-analysis.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/sg-policy-graph.ts web/lib/sg-policy-graph.test.ts web/components/inventory/metrics/SgAnalysisSection.tsx
git commit -m "feat(sg): add policy relationship graphs"
```

### Task 4: Add Admin Flow Log Source Configuration and Validation

**Files:**
- Create: `web/lib/sg-rules/sources.ts`
- Create: `web/lib/sg-rules/sources.test.ts`
- Create: `web/app/api/sg-rules/sources/route.ts`
- Create: `web/app/api/sg-rules/sources/[id]/route.ts`
- Create: `scripts/v2/workers/sg_rules/source_validation.py`
- Create: `scripts/v2/workers/test_sg_source_validation.py`
- Modify: `scripts/v2/workers/handlers.py`

- [ ] **Step 1: Write authorization, overlap, and schema tests**

```ts
it('rejects non-admin source creation', async () => {
  expect(await POST(asViewer(request))).toMatchObject({ status: 403 });
});

it('rejects overlapping VPC scopes under the same resource account and region', async () => {
  await expect(saveSource({ vpcScope: ['vpc-a'] })).resolves.toBeDefined();
  await expect(saveSource({ vpcScope: ['vpc-a', 'vpc-b'] })).rejects.toThrow('overlap');
});
```

```py
def test_rejects_table_without_safe_time_partition():
    with pytest.raises(InvalidSource, match="partition"):
        validate_source(table_without_partitions)
```

- [ ] **Step 2: Verify red**

Run:

```bash
cd web && npx vitest run lib/sg-rules/sources.test.ts
cd ../scripts/v2/workers && python3 -m pytest test_sg_source_validation.py -q
```

Expected: FAIL because source modules are absent.

- [ ] **Step 3: Implement pending-save and asynchronous validation**

```ts
const source = await savePendingSource(client, validatedBody, user.sub);
await enqueueJob('sg_rule_source_validate', { source_id: source.id }, {
  idempotencyKey: `sg-source-validate:${source.id}:${source.updatedAt}`,
});
```

The worker resolves canonical columns, partition strategy, scope isolation, workgroup cutoff, S3 location, and active `DescribeFlowLogs` coverage. It stores capabilities in `validation`; administrators never submit SQL.

- [ ] **Step 4: Register and verify the Lambda job**

```py
REGISTRY["sg_rule_source_validate"] = (_sg_rule_source_validate, "lambda")
```

Run the TypeScript and Python tests from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/sg-rules web/app/api/sg-rules/sources scripts/v2/workers/sg_rules scripts/v2/workers/test_sg_source_validation.py scripts/v2/workers/handlers.py
git commit -m "feat(sg-rules): add Athena source validation"
```

### Task 5: Synchronize Rule Inventory and ENI Membership

**Files:**
- Create: `scripts/v2/workers/sg_rules/inventory.py`
- Create: `scripts/v2/workers/sg_rules/membership.py`
- Create: `scripts/v2/workers/test_sg_inventory.py`
- Modify: `scripts/v2/workers/handlers.py`

- [ ] **Step 1: Write paginator, fingerprint, and interval tests**

```py
def test_membership_opens_new_interval_only_when_fingerprint_changes():
    sync_membership(conn, eni("eni-1", ["sg-a"], ["10.0.0.1"]), at=t1)
    sync_membership(conn, eni("eni-1", ["sg-a"], ["10.0.0.1"]), at=t2)
    assert interval_count(conn, "eni-1") == 1
    sync_membership(conn, eni("eni-1", ["sg-b"], ["10.0.0.1"]), at=t3)
    assert interval_count(conn, "eni-1") == 2
```

- [ ] **Step 2: Verify red**

Run: `cd scripts/v2/workers && python3 -m pytest test_sg_inventory.py -q`

Expected: FAIL because inventory modules are absent.

- [ ] **Step 3: Implement daily all-account inventory**

Use paginated `DescribeSecurityGroupRules`, `DescribeNetworkInterfaces`, and managed prefix-list reads through onboarded read-only roles. Upsert rules by `sgr-*`, mark absent rules inactive, and isolate evidence epochs by match-field fingerprint.

- [ ] **Step 4: Register and verify**

```py
REGISTRY["sg_rule_inventory"] = (_sg_rule_inventory, "fargate")
```

Run: `cd scripts/v2/workers && python3 -m pytest test_sg_inventory.py test_handlers.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/sg_rules scripts/v2/workers/test_sg_inventory.py scripts/v2/workers/handlers.py
git commit -m "feat(sg-rules): synchronize rules and ENI history"
```

### Task 6: Query Mature Athena Partitions and Match Compatible Rules

**Files:**
- Create: `scripts/v2/workers/sg_rules/query.py`
- Create: `scripts/v2/workers/sg_rules/matcher.py`
- Create: `scripts/v2/workers/sg_rules/activity.py`
- Create: `scripts/v2/workers/test_sg_activity.py`
- Modify: `scripts/v2/workers/handlers.py`

- [ ] **Step 1: Write SQL safety and semantic tests**

```py
def test_query_has_partition_predicates_and_accept_only():
    sql = build_query(validated_source, day=date(2026, 8, 15))
    assert "action = 'ACCEPT'" in sql
    assert "observed_on" in sql
    assert "SELECT *" not in sql

def test_overlapping_rules_are_not_exactly_attributed():
    rows = match_tuple(flow(dstport=443), [cidr_rule("0.0.0.0/0"), cidr_rule("10.0.0.0/8")])
    assert all(row.status == "overlapping" for row in rows)
```

- [ ] **Step 2: Verify red**

Run: `cd scripts/v2/workers && python3 -m pytest test_sg_activity.py -q`

Expected: FAIL because activity modules are absent.

- [ ] **Step 3: Implement source/day bulk processing**

```py
def run_source_day(source, observed_on):
    require_mature(observed_on, delay_hours=48)
    query_id = start_bounded_query(source, build_query(source, observed_on))
    tuples, stats = wait_for_results(query_id, row_cap=2_000_000)
    evidence = aggregate_compatible_matches(tuples, inventory_for_day(observed_on))
    replace_daily_results(source.id, observed_on, evidence, stats)
```

Recompute the latest three mature days, replace rather than add results, fail without partial daily rows when cutoff or row cap is exceeded, and mark incomplete ENI/day coverage `unassessable`.

- [ ] **Step 4: Register and verify**

```py
REGISTRY["sg_rule_activity"] = (_sg_rule_activity, "fargate")
```

Run: `cd scripts/v2/workers && python3 -m pytest test_sg_activity.py test_handlers.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/sg_rules scripts/v2/workers/test_sg_activity.py scripts/v2/workers/handlers.py
git commit -m "feat(sg-rules): aggregate compatible Flow Log evidence"
```

### Task 7: Add Rules API, Table, Detail Graph, Export, and Admin Settings

**Files:**
- Reference baseline: `.superpowers/brainstorm/2026-08-18-network-security-graph-ui.html`
- Create: `web/lib/sg-rules/query.ts`
- Create: `web/lib/sg-rules/query.test.ts`
- Create: `web/app/api/sg-rules/route.ts`
- Create: `web/app/api/sg-rules/export/route.ts`
- Create: `web/app/api/sg-rules/refresh/route.ts`
- Create: `web/app/network/security-groups/rules/page.tsx`
- Create: `web/app/network/security-groups/rules/RulesClient.tsx`

- [ ] **Step 1: Write aggregation and route tests**

```ts
it('does not report no evidence when any required day is missing', () => {
  expect(classifyEvidence({ matches: 0, coveredDays: 89, requiredDays: 90 }))
    .toBe('unassessable');
});

it('defaults to a 90 day window', async () => {
  const response = await GET(makeRequest('/api/sg-rules'));
  expect(response.query.windowDays).toBe(90);
});
```

- [ ] **Step 2: Verify red**

Run: `cd web && npx vitest run lib/sg-rules/query.test.ts`

Expected: FAIL because the query module is absent.

- [ ] **Step 3: Implement bounded Aurora queries and UI**

```ts
export type EvidenceStatus =
  | 'observed_compatible'
  | 'overlapping'
  | 'no_observed_evidence'
  | 'unassessable'
  | 'not_configured';
```

The page provides 30/90/180-day selection, filters, CSV/JSON export, admin-only settings/refresh, status/count/last observed/coverage columns, and a compact `PolicyGraph` detail drawer. All copy says compatible evidence, never exact hit or unused.

Convert the approved `Rule Detail` tab from the HTML baseline into the actual row drawer. The graph,
status summary, evidence list, and Path Check link must be backed by the Rules API rather than
hard-coded fixture data.

- [ ] **Step 4: Verify and build**

Run: `cd web && npx vitest run lib/sg-rules/query.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/sg-rules web/app/api/sg-rules web/app/network/security-groups/rules
git commit -m "feat(sg-rules): add rules evidence experience"
```

### Task 8: Add Default-Off Terraform Gates, Schedules, IAM, and Retention

**Files:**
- Modify: `terraform/v2/foundation/variables.tf`
- Modify: `terraform/v2/foundation/workers.tf`
- Create: `terraform/v2/foundation/sg-rule-activity.tf`
- Create: `scripts/v2/workers/sg_rules/retention.py`

- [ ] **Step 1: Add gate contract tests**

```ts
expect(variableDefault('sg_rule_activity_enabled')).toBe(false);
expect(actions).toContain('athena:StartQueryExecution');
expect(actions).not.toContain('ec2:RevokeSecurityGroupIngress');
expect(actions).not.toContain('ec2:RevokeSecurityGroupEgress');
```

- [ ] **Step 2: Implement the gate and schedules**

```hcl
variable "sg_rule_activity_enabled" {
  type    = bool
  default = false
  validation {
    condition     = !var.sg_rule_activity_enabled || var.workers_enabled
    error_message = "sg_rule_activity_enabled requires workers_enabled."
  }
}
```

Create daily inventory and activity EventBridge dispatchers, manual refresh uses the same dedicated job types, and IAM contains only Describe/Get/List plus Athena query access to configured resources. Add 400-day activity/history and 90-day scan-attempt pruning.

- [ ] **Step 3: Verify**

Run:

```bash
terraform -chdir=terraform/v2/foundation fmt -check
terraform -chdir=terraform/v2/foundation validate
cd web && npx vitest run
cd ../scripts/v2/workers && python3 -m pytest -q
```

Expected: PASS; default plan creates no SG activity infrastructure.

- [ ] **Step 4: Commit**

```bash
git add terraform/v2/foundation scripts/v2/workers/sg_rules
git commit -m "feat(sg-rules): add gated activity scheduling"
```

### Task 9: Browser and Regression Verification

**Files:**
- Create: `web/e2e/security-group-rules.spec.ts`
- Modify: `web/lib/sg-analysis.ts`

- [ ] **Step 1: Correct remaining exact-attribution copy**

Replace comments and strings that call tuple matching exact with `compatible traffic matching`. Preserve current CloudWatch Usage fallback behavior.

- [ ] **Step 2: Add browser tests**

```ts
test('rules and usage graphs render without overlap', async ({ page }) => {
  await page.goto('/network/security-groups/rules');
  await expect(page.getByRole('heading', { name: 'Security Group Rules' })).toBeVisible();
  await page.getByRole('row').nth(1).click();
  await expect(page.getByTestId('policy-graph')).toBeVisible();
  await page.goto('/network/security-groups/usage');
  await expect(page.getByText('보안 그룹 사용 분석')).toBeVisible();
});
```

- [ ] **Step 3: Run final verification**

Run:

```bash
cd web && npx playwright test e2e/security-group-rules.spec.ts
npx vitest run
npm run build
cd ../scripts/v2/workers && python3 -m pytest -q
terraform -chdir=../../../terraform/v2/foundation validate
```

Expected: all tests pass, both graph canvases are nonblank at desktop/mobile sizes, and no mutation action exists.

- [ ] **Step 4: Commit**

```bash
git add web/e2e/security-group-rules.spec.ts web/lib/sg-analysis.ts
git commit -m "test(sg-rules): verify rules and usage workflows"
```
