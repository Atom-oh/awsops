# Network Path Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a saved, asynchronous, read-only path-policy checker whose primary result is a React Flow graph plus an accessible `O/X/?` checklist.

**Architecture:** Dedicated ownership-checked Next.js routes persist definitions and enqueue `network_path` domain jobs. A Fargate worker resolves cached topology, runs bounded live read-only adapters, and atomically writes path, step, and versioned graph snapshots to Aurora. The UI polls the run API and renders the shared `PolicyGraph`; AWSops only generates operator-run validation commands.

**Tech Stack:** Next.js 14, TypeScript, node-pg, Vitest, React Flow, Dagre, Python 3.12, boto3, pg8000, ECS Fargate, SQS/Step Functions, Terraform.

> **2026-08-19 validation note (Phase 0):** codebase verification found several premises here need
> correction before execution — SG-analysis baseline files did not exist on `main` until PR #223
> (now merged), `web/` has no Playwright (its final e2e task must run as a manual Playwright MCP
> check instead), the shared `PolicyGraph` graph contract + component (Task 2's graph half + Task
> 5's canvas) now live at `web/lib/policy-graph.ts` + `web/components/graph/PolicyGraph.tsx`
> (branch `feat/policy-graph-contract`) reusing the existing `web/lib/flow-layout.ts` `layoutFlow`
> and `web/components/ui/DetailPanel.tsx` rather than new implementations, a new Fargate/Lambda job
> type needs explicit packaging (Dockerfile `COPY`, `archive_file.workers_src` entries) beyond the
> `REGISTRY` line or it fails at runtime, and worker roles currently hold no cross-account
> `sts:AssumeRole` grant. Full corrections table and phased execution order in the approved plan
> (Phase 1 covers this document's Task 1, 3, 4, 6, 7 — Task 2's `types.ts`/`reduce.ts` half and
> Task 5's page remain to be done under Phase 1).

---

### Task 1: Persist Checks, Runs, Paths, Steps, and Graph Snapshots

**Files:**
- Create: `terraform/v2/foundation/migrations/01M09YEG0PQSXG94WXCEGHRQDZ_network_path_check.sql`
- Create: `scripts/v2/migrations-network-path.itest.mjs`

- [ ] **Step 1: Write the failing migration integration test**

```js
const tables = [
  'network_path_checks',
  'network_path_runs',
  'network_path_run_paths',
  'network_path_run_steps',
];
for (const table of tables) {
  const row = await db.query(
    `SELECT to_regclass('public.${table}') AS name`,
  );
  assert.equal(row.rows[0].name, table);
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node scripts/v2/migrations-network-path.itest.mjs`

Expected: FAIL because the migration file and tables do not exist.

- [ ] **Step 3: Add the migration**

```sql
CREATE TABLE network_path_checks (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  request jsonb NOT NULL,
  created_by_sub text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE network_path_runs (
  id uuid PRIMARY KEY,
  check_id uuid NOT NULL REFERENCES network_path_checks(id),
  worker_job_id uuid UNIQUE REFERENCES worker_jobs(job_id),
  requested_by_sub text NOT NULL,
  request_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','allowed','blocked','conditional','failed')),
  phase text NOT NULL DEFAULT 'queued',
  graph_snapshot jsonb NOT NULL DEFAULT '{"version":1,"nodes":[],"edges":[]}'::jsonb,
  validation_bundle jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE network_path_run_paths (
  run_id uuid NOT NULL REFERENCES network_path_runs(id) ON DELETE CASCADE,
  path_id text NOT NULL,
  ordinal integer NOT NULL,
  status text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, path_id)
);

CREATE TABLE network_path_run_steps (
  run_id uuid NOT NULL REFERENCES network_path_runs(id) ON DELETE CASCADE,
  path_id text NOT NULL,
  ordinal integer NOT NULL,
  layer text NOT NULL,
  status text NOT NULL CHECK (status IN ('allowed','blocked','unknown','not_run','not_applicable')),
  resource text,
  summary text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at timestamptz NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, path_id, ordinal),
  FOREIGN KEY (run_id, path_id) REFERENCES network_path_run_paths(run_id, path_id) ON DELETE CASCADE
);
```

Add ownership, active-list, run-history, and 400-day retention indexes. Use the repository migration harness to apply the migration twice.

- [ ] **Step 4: Run the migration test**

Run: `node scripts/v2/migrations-network-path.itest.mjs`

Expected: PASS, including a second idempotent application.

- [ ] **Step 5: Commit**

```bash
git add terraform/v2/foundation/migrations/01M09YEG0PQSXG94WXCEGHRQDZ_network_path_check.sql scripts/v2/migrations-network-path.itest.mjs
git commit -m "feat(network-path): add persistence model"
```

### Task 2: Define Deterministic Result and Graph Contracts

**Files:**
- Create: `web/lib/network-path/types.ts`
- Create: `web/lib/network-path/reduce.ts`
- Create: `web/lib/network-path/reduce.test.ts`
- Create: `web/lib/policy-graph.ts`
- Create: `web/lib/policy-graph.test.ts`

- [ ] **Step 1: Write reducer and graph-boundary tests**

```ts
it('returns conditional for mixed active paths', () => {
  expect(reduceRun([
    { id: 'a', steps: [{ status: 'allowed' }] },
    { id: 'b', steps: [{ status: 'blocked' }] },
  ])).toBe('conditional');
});

it('caps persisted graphs and records omitted counts', () => {
  const graph = boundGraph(makeGraph(260, 410), { nodes: 250, edges: 400 });
  expect(graph.nodes).toHaveLength(250);
  expect(graph.edges).toHaveLength(400);
  expect(graph.truncated).toBe(true);
  expect(graph.omitted).toEqual({ nodes: 10, edges: 10 });
});
```

- [ ] **Step 2: Verify red**

Run: `cd web && npx vitest run lib/network-path/reduce.test.ts lib/policy-graph.test.ts`

Expected: FAIL because the modules are absent.

- [ ] **Step 3: Implement the contracts**

```ts
export type StepStatus = 'allowed' | 'blocked' | 'unknown' | 'not_run' | 'not_applicable';
export type RunStatus = 'queued' | 'running' | 'allowed' | 'blocked' | 'conditional' | 'failed';

export interface PolicyGraphDto {
  version: 1;
  capturedAt: string;
  truncated: boolean;
  omitted: { nodes: number; edges: number };
  nodes: PolicyGraphNode[];
  edges: PolicyGraphEdge[];
}

export function reducePath(steps: Array<{ status: StepStatus }>): Exclude<RunStatus, 'queued' | 'running' | 'failed'> {
  const applicable = steps.filter((s) => s.status !== 'not_applicable');
  if (applicable.some((s) => s.status === 'blocked')) return 'blocked';
  if (applicable.some((s) => s.status === 'unknown' || s.status === 'not_run')) return 'conditional';
  return 'allowed';
}
```

Implement stable resource-derived IDs, typed collapsed `+N` nodes, and deterministic sorting before truncation.

- [ ] **Step 4: Verify green**

Run: `cd web && npx vitest run lib/network-path/reduce.test.ts lib/policy-graph.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/network-path web/lib/policy-graph.ts web/lib/policy-graph.test.ts
git commit -m "feat(network-path): define result and graph contracts"
```

### Task 3: Add Saved-Check Repository and Dedicated APIs

**Files:**
- Create: `web/lib/network-path/store.ts`
- Create: `web/lib/network-path/store.test.ts`
- Create: `web/app/api/network-paths/route.ts`
- Create: `web/app/api/network-paths/route.test.ts`
- Create: `web/app/api/network-paths/[id]/route.ts`
- Create: `web/app/api/network-paths/[id]/runs/route.ts`
- Create: `web/app/api/network-path-runs/[runId]/route.ts`

- [ ] **Step 1: Write authorization and idempotency tests**

```ts
it('allows viewers to run but only creator or admin to edit', async () => {
  expect(canRun({ sub: 'viewer' }, check)).toBe(true);
  expect(canEdit({ sub: 'viewer', admin: false }, check)).toBe(false);
  expect(canEdit({ sub: check.createdBySub, admin: false }, check)).toBe(true);
});

it('deduplicates the same request for sixty seconds', async () => {
  const first = await createRun(input);
  const second = await createRun(input);
  expect(second.id).toBe(first.id);
});
```

- [ ] **Step 2: Verify red**

Run: `cd web && npx vitest run lib/network-path/store.test.ts app/api/network-paths/route.test.ts`

Expected: FAIL because routes and store are absent.

- [ ] **Step 3: Implement repository and routes**

```ts
export async function createNetworkPathRun(checkId: string, sub: string) {
  return withTransaction(async (client) => {
    const check = await lockActiveCheck(client, checkId);
    const existing = await findRecentEquivalentRun(client, checkId, sub, check.request, 60);
    if (existing) return existing;
    enforceConcurrency(await countRunning(client, checkId, sub));
    const runId = randomUUID();
    const jobId = randomUUID();
    await insertRunAndJob(client, { runId, jobId, check, sub });
    return { runId, jobId };
  });
}
```

Routes must use immutable Cognito `sub`, `isAdmin`, the feature gate, bounded request validation, and `enqueueJob('network_path', ...)`. `DELETE` performs a soft delete.

- [ ] **Step 4: Verify green**

Run: `cd web && npx vitest run lib/network-path/store.test.ts app/api/network-paths/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/network-path web/app/api/network-paths web/app/api/network-path-runs
git commit -m "feat(network-path): add saved checks and run APIs"
```

### Task 4: Implement the Read-Only Worker Engine

**Files:**
- Create: `scripts/v2/workers/network_path/__init__.py`
- Create: `scripts/v2/workers/network_path/models.py`
- Create: `scripts/v2/workers/network_path/reducer.py`
- Create: `scripts/v2/workers/network_path/topology.py`
- Create: `scripts/v2/workers/network_path/aws_layers.py`
- Create: `scripts/v2/workers/network_path/kubernetes_layers.py`
- Create: `scripts/v2/workers/network_path/l7_layers.py`
- Create: `scripts/v2/workers/network_path/runner.py`
- Create: `scripts/v2/workers/test_network_path.py`
- Modify: `scripts/v2/workers/handlers.py`

- [ ] **Step 1: Write adapter isolation and reduction tests**

```py
def test_adapter_failure_becomes_unknown_without_failing_run():
    result = run_adapters([allowed_adapter, raising_adapter])
    assert [step.status for step in result.steps] == ["allowed", "unknown"]

def test_source_identity_failure_fails_run():
    with pytest.raises(SourceResolutionError):
        resolve_source({"kind": "pod", "cluster": "missing", "namespace": "orders", "name": "api"})
```

- [ ] **Step 2: Verify red**

Run: `cd scripts/v2/workers && python3 -m pytest test_network_path.py -q`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement bounded adapters and atomic progress persistence**

```py
def execute(payload, dry_run=False):
    if dry_run:
        return {"dry_run": True, "request": payload["request"]}
    run = RunRepository.connect(payload["run_id"])
    source = resolve_source(payload["request"]["source"])
    candidates = discover_active_paths(source, payload["request"]["destination"])
    for candidate in candidates:
        for adapter in adapters_for(candidate):
            step = safe_evaluate(adapter, candidate, payload["request"])
            run.persist_step_and_graph(candidate, step)
            if step.status == "blocked":
                run.mark_remaining_not_run(candidate)
                break
    return run.conclude_and_persist()
```

AWS calls are read-only and paginated. Route selection applies longest prefix, static/propagated precedence, TGW association/blackhole rules, and return-path evaluation. Kubernetes failures after source resolution become `unknown`; on-premises paths terminate at an unknown boundary. No adapter calls Reachability Analyzer creation or executes a probe.

- [ ] **Step 4: Register the Fargate job and verify**

```py
def _network_path(payload, dry_run):
    from network_path.runner import execute
    return execute(payload, dry_run), None

REGISTRY["network_path"] = (_network_path, "fargate")
```

Run: `cd scripts/v2/workers && python3 -m pytest test_network_path.py test_handlers.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/workers/network_path scripts/v2/workers/test_network_path.py scripts/v2/workers/handlers.py
git commit -m "feat(network-path): add deterministic worker engine"
```

### Task 5: Add the Shared React Flow Graph and Path Check UI

**Files:**
- Reference baseline: `.superpowers/brainstorm/2026-08-18-network-security-graph-ui.html`
- Create: `web/components/graph/PolicyGraph.tsx`
- Create: `web/components/graph/PolicyGraph.test.tsx`
- Create: `web/app/network-paths/page.tsx`
- Create: `web/app/network-paths/NetworkPathClient.tsx`
- Modify: `web/lib/inventory-types.ts`
- Modify: `web/lib/i18n.ts`
- Modify: `web/components/shell/Sidebar.test.tsx`

- [ ] **Step 1: Write UI tests**

```tsx
it('renders graph controls and checklist fallback', () => {
  render(<PolicyGraph graph={fixtureGraph} compact={false} />);
  expect(screen.getByLabelText('Fit graph')).toBeInTheDocument();
  expect(screen.getByText('Security group allowed tcp/443')).toBeInTheDocument();
});
```

- [ ] **Step 2: Verify red**

Run: `cd web && npx vitest run components/graph/PolicyGraph.test.tsx components/shell/Sidebar.test.tsx`

Expected: FAIL because the component and navigation entry are absent.

- [ ] **Step 3: Implement the graph and page**

```tsx
export default function PolicyGraph({ graph, compact = false }: Props) {
  const { nodes, edges } = layoutPolicyGraph(graph, compact);
  return (
    <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false}>
      <Controls showInteractive={false} />
      {!compact && <MiniMap pannable zoomable />}
      <Background />
    </ReactFlow>
  );
}
```

The page provides source/destination selectors, saved definitions, progress, path filters, docked detail panel, checklist, run comparison, and copyable operator-run validation commands. It polls only while a run is non-terminal.

Reproduce the approved `Path Check` tab from
`.superpowers/brainstorm/2026-08-18-network-security-graph-ui.html` as real React:

- the selector toolbar and saved-check controls use existing form components
- the graph canvas is `PolicyGraph`, not static HTML/SVG
- the right evidence panel is the existing non-modal detail-panel pattern
- the lower checklist is the accessible source of truth
- status icons, labels, path filter, minimap, and running-edge state match the mockup
- desktop and mobile geometry are verified against screenshots of the approved HTML

- [ ] **Step 4: Verify green and build**

Run: `cd web && npx vitest run components/graph/PolicyGraph.test.tsx components/shell/Sidebar.test.tsx && npm run build`

Expected: PASS and successful Next.js build.

- [ ] **Step 5: Commit**

```bash
git add web/components/graph web/app/network-paths web/lib/inventory-types.ts web/lib/i18n.ts web/components/shell/Sidebar.test.tsx
git commit -m "feat(network-path): add graph-first user interface"
```

### Task 6: Gate Infrastructure, IAM, Onboarding Bundle, and Retention

**Files:**
- Modify: `terraform/v2/foundation/variables.tf`
- Modify: `terraform/v2/foundation/workers.tf`
- Create: `terraform/v2/foundation/network-path.tf`
- Create: `scripts/v2/eks/network-path-readonly-onboarding.sh`
- Create: `scripts/v2/workers/network_path_retention.py`
- Modify: `scripts/v2/workers/requirements.txt`

- [ ] **Step 1: Add failing Terraform contract assertions**

```ts
expect(variableDefault('network_path_check_enabled')).toBe(false);
expect(workerActions).not.toContain('ec2:CreateNetworkInsightsPath');
expect(workerActions).not.toContain('ec2:DeleteNetworkInsightsPath');
```

- [ ] **Step 2: Add default-off infrastructure**

```hcl
variable "network_path_check_enabled" {
  type    = bool
  default = false
  validation {
    condition     = !var.network_path_check_enabled || var.workers_enabled
    error_message = "network_path_check_enabled requires workers_enabled."
  }
}
```

Grant only required Describe/Get/List actions, scoped role assumption for onboarded accounts, and EKS `DescribeCluster`. Bundle worker package files into Fargate only. Add an EventBridge retention invocation that deletes runs older than 400 days and never deletes AWS resources.

- [ ] **Step 3: Add the operator-run EKS bundle**

The script prints or applies only when the operator explicitly executes it. It creates an EKS Access Entry and a ClusterRole limited to `get/list/watch`; AWSops never invokes it.

- [ ] **Step 4: Verify**

Run:

```bash
terraform -chdir=terraform/v2/foundation fmt -check
terraform -chdir=terraform/v2/foundation validate
cd web && npx vitest run
cd ../scripts/v2/workers && python3 -m pytest -q
```

Expected: all commands pass; a default-variable plan adds no Network Path resources.

- [ ] **Step 5: Commit**

```bash
git add terraform/v2/foundation scripts/v2/eks/network-path-readonly-onboarding.sh scripts/v2/workers
git commit -m "feat(network-path): add gated worker infrastructure"
```

### Task 7: Browser Verification and Documentation

**Files:**
- Create: `web/e2e/network-path.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-13-network-path-check-design.md`

- [ ] **Step 1: Add Playwright checks**

```ts
test('path graph is nonblank on desktop and mobile', async ({ page }) => {
  await page.goto('/network-paths');
  await expect(page.getByTestId('policy-graph')).toBeVisible();
  expect(await page.getByTestId('policy-graph').screenshot()).not.toEqual(Buffer.alloc(0));
  await expect(page.getByRole('table', { name: 'Policy checklist' })).toBeVisible();
});
```

Capture the approved HTML and implemented page at the same desktop/mobile viewport sizes. The
implementation may use the current product tokens and live data density, but must preserve the
approved information hierarchy, graph placement, evidence panel, and checklist order.

- [ ] **Step 2: Run focused browser verification**

Run: `cd web && npx playwright test e2e/network-path.spec.ts`

Expected: PASS at desktop and mobile viewports with no overlap or blank canvas.

- [ ] **Step 3: Run final verification**

Run:

```bash
cd web && npx vitest run && npm run build
cd ../agent && python3 -m pytest test_agent.py -q
cd ../scripts/v2/workers && python3 -m pytest -q
terraform -chdir=../../../terraform/v2/foundation validate
```

Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add web/e2e/network-path.spec.ts docs/superpowers/specs/2026-08-13-network-path-check-design.md
git commit -m "test(network-path): verify graph workflow"
```
