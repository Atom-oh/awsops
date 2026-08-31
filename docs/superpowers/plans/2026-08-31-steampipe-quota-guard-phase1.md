# Steampipe Quota Guard Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound every scheduled and manual Steampipe inventory refresh behind an explicit plugin-wide AWS API budget and Lambda concurrency backpressure while retaining the 15-minute sync contract.

**Architecture:** The Steampipe config renderer emits one plugin-wide limiter shared by every account, Region, service, and action. The inventory sync Lambda has reserved concurrency plus a 15-minute async event-age ceiling, and web refresh requests enqueue asynchronous work through the same path instead of waiting synchronously. Structured JSON logs expose dispatch, completion, failure, and elapsed time without introducing a second queue or mutation path.

**Tech Stack:** Python 3.12 Lambda, Steampipe 0.22.0 with AWS plugin 0.142.0, Terraform ≥1.15/AWS provider `~>6.0`, TypeScript/Next.js 14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-31-steampipe-quota-safe-aurora-mcp-design.md`

## Global Constraints

- Inventory schedule remains `rate(15 minutes)`.
- `steampipe_enabled=false` must still produce zero Steampipe/sync resources and zero cost.
- Default plugin budget is global `max_concurrency=4`, `bucket_size=4`, `fill_rate=2.0`.
- Sync Lambda reserved concurrency defaults to `4`; allowed range is `1..20`.
- Async inventory events older than 900 seconds are discarded and function-error retries are disabled.
- Manual refresh uses `InvocationType="Event"` and returns `queued`; it never bypasses the same Lambda/Steampipe limits.
- All infrastructure remains ARM64 and read-only; no AWS resource mutation or autonomy is introduced.
- Secrets remain in Secrets Manager/Aurora IAM auth; no secret is added to task environment variables.
- Shared infrastructure is never applied with `-auto-approve`.

---

### Task 1: Render and validate the Steampipe AWS plugin limiter

**Files:**
- Modify: `scripts/v2/steampipe/spc_render.py`
- Modify: `scripts/v2/steampipe/gen_spc_entrypoint.py`
- Modify: `scripts/v2/steampipe/aws.spc`
- Test: `scripts/v2/steampipe/test_spc_render.py`

**Interfaces:**
- Produces: `LimiterConfig(max_concurrency: int, bucket_size: int, fill_rate: float)`
- Produces: `limiter_config_from_env(env: Mapping[str, str] | None = None) -> LimiterConfig`
- Changes: `render_spc(rows, limiter: LimiterConfig | None = None) -> str`
- Environment:
  - `STEAMPIPE_AWS_MAX_CONCURRENCY`
  - `STEAMPIPE_AWS_BUCKET_SIZE`
  - `STEAMPIPE_AWS_FILL_RATE`

- [ ] **Step 1: Write failing renderer and environment-validation tests**

Add tests that assert:

```python
from spc_render import LimiterConfig, limiter_config_from_env, render_spc


def test_default_plugin_limiter_is_rendered_once_and_is_global():
    spc = render_spc([{
        "account_id": "123456789012", "is_host": True,
        "role_name": "AWSopsReadOnlyRole", "external_id": None,
        "all_regions": True, "regions": [],
    }])
    assert spc.count('plugin "aws"') == 1
    assert 'limiter "awsops_global"' in spc
    assert "max_concurrency = 4" in spc
    assert "bucket_size = 4" in spc
    assert "fill_rate = 2.0" in spc
    assert "scope =" not in spc


def test_custom_limiter_values_are_rendered():
    spc = render_spc([], LimiterConfig(2, 3, 0.5))
    assert "max_concurrency = 2" in spc
    assert "bucket_size = 3" in spc
    assert "fill_rate = 0.5" in spc


def test_limiter_env_validation_fails_closed():
    with pytest.raises(ValueError, match="STEAMPIPE_AWS_MAX_CONCURRENCY"):
        limiter_config_from_env({"STEAMPIPE_AWS_MAX_CONCURRENCY": "0"})
    with pytest.raises(ValueError, match="STEAMPIPE_AWS_BUCKET_SIZE"):
        limiter_config_from_env({"STEAMPIPE_AWS_BUCKET_SIZE": "41"})
    with pytest.raises(ValueError, match="STEAMPIPE_AWS_FILL_RATE"):
        limiter_config_from_env({"STEAMPIPE_AWS_FILL_RATE": "0"})
```

Update the entrypoint test to assert `render_spc(rows, limiter_config_from_env())` is used when the
config file is regenerated.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
python3 -m pytest scripts/v2/steampipe/test_spc_render.py -q
```

Expected: collection/import failure because `LimiterConfig` and `limiter_config_from_env` do not
exist, or assertion failure because no plugin limiter is rendered.

- [ ] **Step 3: Implement the pure limiter configuration and renderer**

Add to `spc_render.py`:

```python
from dataclasses import dataclass
import os


@dataclass(frozen=True)
class LimiterConfig:
    max_concurrency: int = 4
    bucket_size: int = 4
    fill_rate: float = 2.0


def _bounded_number(name, raw, cast, low, high):
    try:
        value = cast(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be numeric")
    if value < low or value > high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return value


def limiter_config_from_env(env=None):
    source = os.environ if env is None else env
    return LimiterConfig(
        max_concurrency=_bounded_number(
            "STEAMPIPE_AWS_MAX_CONCURRENCY",
            source.get("STEAMPIPE_AWS_MAX_CONCURRENCY", "4"), int, 1, 20),
        bucket_size=_bounded_number(
            "STEAMPIPE_AWS_BUCKET_SIZE",
            source.get("STEAMPIPE_AWS_BUCKET_SIZE", "4"), int, 1, 40),
        fill_rate=_bounded_number(
            "STEAMPIPE_AWS_FILL_RATE",
            source.get("STEAMPIPE_AWS_FILL_RATE", "2"), float, 0.1, 20.0),
    )
```

Render this block before connection blocks:

```hcl
plugin "aws" {
  limiter "awsops_global" {
    max_concurrency = 4
    bucket_size     = 4
    fill_rate       = 2.0
  }
}
```

Do not render `scope`; one bucket must protect the whole collector rather than multiplying per
connection/Region/service/action. Update `gen_spc_entrypoint.py` to pass the validated environment
configuration. Update the static `aws.spc` example to contain the same default plugin block.

- [ ] **Step 4: Run focused and full Steampipe tests**

Run:

```bash
python3 -m pytest scripts/v2/steampipe/test_spc_render.py -q
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py scripts/v2/steampipe/test_sync_inventory_additions.py -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/steampipe/spc_render.py \
        scripts/v2/steampipe/gen_spc_entrypoint.py \
        scripts/v2/steampipe/aws.spc \
        scripts/v2/steampipe/test_spc_render.py
git commit -m "feat: add global Steampipe AWS API limiter"
```

---

### Task 2: Add Terraform quota configuration and Lambda backpressure

**Files:**
- Modify: `terraform/v2/foundation/variables.tf`
- Modify: `terraform/v2/foundation/steampipe.tf`
- Modify: `terraform/v2/foundation/terraform.tfvars.example`
- Modify: `tests/structure/test-steampipe-fanout.sh`

**Interfaces:**
- Produces Terraform variables:
  - `steampipe_aws_max_concurrency: number = 4`
  - `steampipe_aws_bucket_size: number = 4`
  - `steampipe_aws_fill_rate: number = 2`
  - `steampipe_sync_reserved_concurrency: number = 4`
- Produces Lambda async config:
  - `maximum_event_age_in_seconds = 900`
  - `maximum_retry_attempts = 0`

- [ ] **Step 1: Extend the structure test first**

Add checks equivalent to:

```bash
grep -Eq 'STEAMPIPE_AWS_MAX_CONCURRENCY' "$SP"
grep -Eq 'STEAMPIPE_AWS_BUCKET_SIZE' "$SP"
grep -Eq 'STEAMPIPE_AWS_FILL_RATE' "$SP"
grep -Eq 'reserved_concurrent_executions[[:space:]]*=[[:space:]]*var\.steampipe_sync_reserved_concurrency' "$SP"
grep -Eq 'maximum_event_age_in_seconds[[:space:]]*=[[:space:]]*900' "$SP"
grep -Eq 'maximum_retry_attempts[[:space:]]*=[[:space:]]*0' "$SP"
```

Also assert every new variable defaults to the values in Global Constraints and has a validation
block.

- [ ] **Step 2: Run the structure test and verify failure**

Run:

```bash
bash tests/structure/test-steampipe-fanout.sh
```

Expected: new limiter/concurrency checks fail.

- [ ] **Step 3: Add validated Terraform variables**

Add number variables with exact validation:

```hcl
variable "steampipe_aws_max_concurrency" {
  type        = number
  default     = 4
  description = "Global Steampipe AWS plugin maximum concurrent upstream calls."
  validation {
    condition     = floor(var.steampipe_aws_max_concurrency) == var.steampipe_aws_max_concurrency && var.steampipe_aws_max_concurrency >= 1 && var.steampipe_aws_max_concurrency <= 20
    error_message = "steampipe_aws_max_concurrency must be an integer from 1 to 20."
  }
}
```

Use the same pattern for bucket size `1..40`, fill rate `0.1..20`, and reserved concurrency integer
`1..20`.

- [ ] **Step 4: Wire task environment and Lambda controls**

Add non-secret task environment values:

```hcl
{ name = "STEAMPIPE_AWS_MAX_CONCURRENCY", value = tostring(var.steampipe_aws_max_concurrency) },
{ name = "STEAMPIPE_AWS_BUCKET_SIZE", value = tostring(var.steampipe_aws_bucket_size) },
{ name = "STEAMPIPE_AWS_FILL_RATE", value = tostring(var.steampipe_aws_fill_rate) },
```

Add to `aws_lambda_function.inv_sync`:

```hcl
reserved_concurrent_executions = var.steampipe_sync_reserved_concurrency
```

Add:

```hcl
resource "aws_lambda_function_event_invoke_config" "inv_sync" {
  count                        = local.sp
  function_name                = aws_lambda_function.inv_sync[0].function_name
  maximum_event_age_in_seconds = 900
  maximum_retry_attempts       = 0
}
```

Document optional overrides in `terraform.tfvars.example`.

- [ ] **Step 5: Format and run static verification**

Run:

```bash
terraform -chdir=terraform/v2/foundation fmt -check
bash tests/structure/test-steampipe-fanout.sh
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add terraform/v2/foundation/variables.tf \
        terraform/v2/foundation/steampipe.tf \
        terraform/v2/foundation/terraform.tfvars.example \
        tests/structure/test-steampipe-fanout.sh
git commit -m "feat: bound Steampipe inventory sync concurrency"
```

---

### Task 3: Make manual inventory refresh use the asynchronous bounded path

**Files:**
- Modify: `web/lib/inventory.ts`
- Modify: `web/lib/inventory.test.ts`
- Modify: `web/app/api/inventory/[type]/refresh/route.ts`
- Test: `web/app/api/inventory/[type]/refresh/route.test.ts`
- Test: `web/app/api/security/refresh/route.test.ts`

**Interfaces:**
- Changes: `triggerSync(type: string) -> Promise<{status: "queued"}>`
- AWS request: `InvokeCommand({FunctionName, InvocationType: "Event", Payload})`

- [ ] **Step 1: Replace the triggerSync test with the queued contract**

Write:

```typescript
it('queues the sync Lambda asynchronously through the bounded path', async () => {
  lambdaSend.mockResolvedValue({ StatusCode: 202 });
  const { triggerSync } = await import('./inventory');
  await expect(triggerSync('ec2')).resolves.toEqual({ status: 'queued' });
  const command = lambdaSend.mock.calls[0][0] as { input: Record<string, unknown> };
  expect(command.input).toMatchObject({
    FunctionName: 'fn',
    InvocationType: 'Event',
  });
});

it('rejects an unexpected async invoke status', async () => {
  lambdaSend.mockResolvedValue({ StatusCode: 200 });
  const { triggerSync } = await import('./inventory');
  await expect(triggerSync('ec2')).rejects.toThrow('inventory sync enqueue failed');
});
```

Update route tests to expect `sync.status === "queued"` and HTTP success without waiting for new
Aurora rows.

- [ ] **Step 2: Run focused Vitest and verify failure**

Run:

```bash
cd web && npx vitest run lib/inventory.test.ts \
  app/api/inventory/'[type]'/refresh/route.test.ts \
  app/api/security/refresh/route.test.ts
```

Expected: current command has no `InvocationType`, parses a payload, and returns the old synchronous
result.

- [ ] **Step 3: Implement asynchronous enqueue**

Replace payload parsing with:

```typescript
const out = await lambdaClient().send(new InvokeCommand({
  FunctionName: fn,
  InvocationType: 'Event',
  Payload: new TextEncoder().encode(JSON.stringify({ type })),
}));
if (out.StatusCode !== 202) {
  throw new Error(`inventory sync enqueue failed: status ${out.StatusCode ?? 'unknown'}`);
}
return { status: 'queued' as const };
```

Keep the type allowlist/admin checks unchanged. Update comments so no route claims that refresh
waits for Steampipe/Aurora completion.

- [ ] **Step 4: Run focused and full inventory tests**

Run:

```bash
cd web && npx vitest run lib/inventory.test.ts \
  app/api/inventory/'[type]'/refresh/route.test.ts \
  app/api/security/refresh/route.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/lib/inventory.ts web/lib/inventory.test.ts \
        'web/app/api/inventory/[type]/refresh/route.ts' \
        'web/app/api/inventory/[type]/refresh/route.test.ts' \
        web/app/api/security/refresh/route.test.ts
git commit -m "feat: queue inventory refresh through bounded sync path"
```

---

### Task 4: Add structured sync lifecycle logs

**Files:**
- Modify: `scripts/v2/steampipe/sync_lambda.py`
- Modify: `scripts/v2/steampipe/test_sync_lambda_queries.py`

**Interfaces:**
- Produces: `_log(event: str, **fields) -> None`
- Log events:
  - `inventory_sync_dispatch`
  - `inventory_sync_complete`
  - `inventory_sync_busy`
  - `inventory_sync_failed`

- [ ] **Step 1: Write failing log-contract tests**

Add tests using `capsys` and injected sync dependencies:

```python
def test_log_is_structured_json(capsys):
    mod = load_sync_lambda()
    mod._log("inventory_sync_complete", resource_type="ec2", row_count=3, elapsed_ms=12)
    record = json.loads(capsys.readouterr().out)
    assert record == {
        "event": "inventory_sync_complete",
        "resource_type": "ec2",
        "row_count": 3,
        "elapsed_ms": 12,
    }


def test_all_dispatch_logs_type_count(capsys):
    mod = load_sync_lambda()
    mod._lambda = FakeLambda()
    mod.lambda_handler({"type": "all"}, FakeContext())
    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    hit = next(x for x in records if x["event"] == "inventory_sync_dispatch")
    assert hit["type_count"] == len(mod.QUERIES) + len(mod.SDK_SYNCS)
```

Extend an existing success/failure test to assert the terminal log carries `resource_type`,
`elapsed_ms`, and either `row_count` or the bounded error string.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py -q
```

Expected: `_log` missing or lifecycle event assertions fail.

- [ ] **Step 3: Implement structured logs**

Add:

```python
import time


def _log(event, **fields):
    print(json.dumps({"event": event, **fields}, default=str, sort_keys=True))
```

Measure `started = time.monotonic()` at the beginning of `sync()`. Emit exactly one terminal event:

- busy → `inventory_sync_busy`,
- success → `inventory_sync_complete` with row count,
- failure → `inventory_sync_failed` with the existing 300-character error cap.

Emit `inventory_sync_dispatch` once for `type=all`. Do not log secrets, SQL text, credentials, or raw
inventory payloads.

- [ ] **Step 4: Run Steampipe suites**

Run:

```bash
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py \
  scripts/v2/steampipe/test_sync_inventory_additions.py \
  scripts/v2/steampipe/test_spc_render.py -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/steampipe/sync_lambda.py \
        scripts/v2/steampipe/test_sync_lambda_queries.py
git commit -m "feat: log bounded inventory sync lifecycle"
```

---

### Task 5: Record ADR-021 and verify Phase 1

**Files:**
- Create: `docs/decisions/021-quota-isolated-inventory-reads.md`
- Modify: `docs/decisions/BASELINE.md`
- Modify: `docs/decisions/001-v2-foundation.md`
- Modify: `docs/decisions/010-inventory-resource-model.md`
- Modify: `docs/reference/03-data-aurora.md`
- Modify: `docs/reference/05-agentcore.md`
- Create: `docs/runbooks/steampipe-quota-and-staleness.md`

**Interfaces:**
- Decision status: accepted architecture, Phase 1 implemented, Phases 2-3 not yet live
- Current-truth wording must continue to state that direct AgentCore inventory calls remain until
  the Phase 2 catalog retirement is deployed.

- [ ] **Step 1: Write the bilingual ADR and current-truth updates**

ADR-021 must state:

- why read-only API calls can still harm production availability,
- selected architecture: quota-limited Steampipe → Aurora → domain MCP,
- only bounded CloudWatch metrics/logs remain live after the complete rollout,
- exact Phase 1 defaults,
- no silent live fallback when Aurora inventory is stale/unavailable,
- rollout status table distinguishing implemented Phase 1 from pending Phase 2/3,
- no ADR-005 relaxation.

Update BASELINE in the same commit. Do not claim Phase 2/3 is already live. Amend ADR-001/010 and
the reference docs with a dated rollout note instead of rewriting current behavior prematurely.

- [ ] **Step 2: Write the operator runbook**

The runbook must include:

- variables and defaults,
- how to inspect generated `aws.spc`,
- CloudWatch log event names,
- how to identify stale inventory,
- safe tuning rule: lowering limits is immediate; raising requires observed production headroom,
- rollback by restoring defaults/catalog without destructive database changes,
- deployment order: Terraform saved plan/apply → build/push Steampipe image → wait stable → trigger
  one sync → verify freshness.

- [ ] **Step 3: Run documentation and repository consistency checks**

Run:

```bash
rg -n 'T[B]D|T[O]DO|PLACEHOLDER' \
  docs/decisions/021-quota-isolated-inventory-reads.md \
  docs/runbooks/steampipe-quota-and-staleness.md
git diff --check
bash tests/structure/test-steampipe-fanout.sh
python3 -m pytest scripts/v2/steampipe/test_spc_render.py \
  scripts/v2/steampipe/test_sync_lambda_queries.py \
  scripts/v2/steampipe/test_sync_inventory_additions.py -q
cd web && npx vitest run lib/inventory.test.ts \
  app/api/inventory/'[type]'/refresh/route.test.ts \
  app/api/security/refresh/route.test.ts
```

Expected: no placeholder matches and all tests pass.

- [ ] **Step 4: Run Terraform validation if backend initialization is available**

Run:

```bash
terraform -chdir=terraform/v2/foundation fmt -check
terraform -chdir=terraform/v2/foundation validate
```

If `validate` cannot run because providers/backend are unavailable in the sandbox, record that exact
environment limitation; do not invent a successful result and do not run `apply`.

- [ ] **Step 5: Commit**

```bash
git add docs/decisions/021-quota-isolated-inventory-reads.md \
        docs/decisions/BASELINE.md \
        docs/decisions/001-v2-foundation.md \
        docs/decisions/010-inventory-resource-model.md \
        docs/reference/03-data-aurora.md \
        docs/reference/05-agentcore.md \
        docs/runbooks/steampipe-quota-and-staleness.md
git commit -m "docs: adopt quota-isolated inventory collection"
```

---

## Phase 1 Completion Gate

Phase 1 is complete only when:

- generated configs contain exactly one global limiter,
- scheduled/manual refreshes share the same reserved-concurrency path,
- async events expire within the 15-minute schedule window,
- relevant Python, Vitest, structure, and Terraform checks pass,
- ADR-021 and BASELINE describe Phase 1 as implemented and Phase 2/3 as pending,
- no production apply has been performed by the agent.

Phase 2 and Phase 3 require separate plans derived from the same approved spec.
