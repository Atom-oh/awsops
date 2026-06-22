# 05. AgentCore Agents — v2 Reference

## Purpose / 목적

The AI brain of AWSops v2: a Strands agent on **AgentCore Runtime** fronted by domain
**gateways** that expose read-only MCP tools, plus a **Memory** store and a **Code
Interpreter**. v2 replaces v1's hand-run CLI/`06*` scripts and `config.json` ARN
injection with a single **idempotent boto3 provisioner** driven from Terraform outputs,
with all config delivered through SSM.

AWSops v2의 AI 두뇌: AgentCore **Runtime** 위의 Strands 에이전트를, 읽기 전용 MCP 도구를
노출하는 도메인 **게이트웨이**들이 감싸고, **Memory** 저장소와 **Code Interpreter**를 더한
구조. v2는 v1의 수동 CLI/`06*` 스크립트 + `config.json` ARN 손주입을 **멱등 boto3
provisioner** 하나로 대체하고, 모든 설정을 SSM으로 전달한다.

## Current design / 현행 설계

**Components (provisioned skeleton):**
- **AgentCore Runtime** — Strands; reuses `agent/agent.py` as-is. Gateway URLs are
  injected via a `GATEWAYS_JSON` env var (agent.py's documented discovery fallback —
  no awscli-in-image dependency). Runtime name `awsops_v2_agent` (underscores only).
- **8 section gateways** — `awsops-v2-{network,container,data,security,cost,monitoring,iac,ops}-gateway`
  (ADR-004 canonical count = **8**). **External observability is NOT a 9th gateway** — per
  **ADR-039** it is the **Integrations axis** (the egress MCP substrate), re-homing what an
  earlier draft listed as an `external-obs` gateway. `monitoring` covers AWS-native monitoring;
  the external-obs plugin datasource registry / OTLP / datasource-diag re-home is the Integrations
  axis (P3).
- **Memory** — `awsops_v2_memory-*`, `eventExpiryDuration = 365` days.
- **Code Interpreter** — `awsops_v2_code_interpreter-*` (underscores only).

**Design target:** **9 section agents + 1 incident orchestrator** (the orchestrator is
P4). **Currently deployed: 2 read-only target slices** that exercise every provisioner
code path — `iam-mcp` (14 tools → security gateway) and `flow-monitor` (1 tool → network
gateway). The **full Lambda fleet is P3.**

**Provisioner:** `scripts/v2/agentcore/{catalog.py, provision.py}` — `catalog.py` holds
the 9 gateway names + the target tool schemas; `provision.py` does boto3 `list →
create/update` for Runtime, the 9 gateways, the target slices, Memory, and the Code
Interpreter, then writes ARNs to SSM and prints a per-resource diff report
(CREATED/EXISTS/UPDATED/ERR). `make agentcore` (via `scripts/v2/agentcore.mjs`) builds +
pushes the **arm64** agent image, then runs the provisioner; `make agentcore SMOKE=1`
also invokes the runtime end-to-end. **Everything is gated by `agentcore_enabled`**
(default `false` → `count`/`for_each` = 0, a no-op).

**Terraform-owned parts** (`terraform/v2/foundation/ai.tf`): dual-tier ECR
(`awsops-v2-agentcore`), the AgentCore IAM role (Runtime + gateways), the agent Lambda
role + the 2-Lambda slice (`for_each` + `archive_file` + permission), 3 SSM placeholder
params (`ignore_changes = [value]`), and the web task-role SSM read grant. Control-plane
resources are **not** Terraform-native, so they live in `provision.py`.

**Config source of truth = SSM**, at `/ops/awsops-v2/agentcore/{runtime_arn,
interpreter_id, memory_id}`. The web BFF reads these at **runtime** via the task role —
**not** ECS `valueFrom** — to avoid a task-start race. Placeholders are written by
Terraform; `provision.py` overwrites with real values.

## Decisions (ADRs) / 결정

- **ADR-031** — runtime-customizable agents & skills (Aurora catalog + resolver +
  registry-agnostic `agent.py`; built-in vs custom tiers; per-account Agent Spaces;
  BYO-MCP). [`../../decisions/031-runtime-customizable-agents-skills.md`](../../decisions/031-runtime-customizable-agents-skills.md)
- **ADR-004** — gateway role split (note the **2026-06-03 correction: 7 → 8 gateways**;
  v2 further splits monitoring → 9). [`../../decisions/004-gateway-role-split.md`](../../decisions/004-gateway-role-split.md)
- **ADR-002 / ADR-025** — AI hybrid routing & multi-route parallel synthesis (the
  classifier picks built-in routes + enabled custom agents).
  [`../../decisions/002-ai-hybrid-routing.md`](../../decisions/002-ai-hybrid-routing.md),
  [`../../decisions/025-multi-route-parallel-synthesis.md`](../../decisions/025-multi-route-parallel-synthesis.md)

## Key files / 핵심 파일

| File | Role |
|------|------|
| `terraform/v2/foundation/ai.tf` | TF-owned ECR/IAM/Lambda-slice/SSM/web-grant (gated on `agentcore_enabled`) |
| `scripts/v2/agentcore.mjs` | `make agentcore` entry — build+push arm64 image → run provisioner |
| `scripts/v2/agentcore/catalog.py` | 9 gateway names + GW descriptions + target tool schemas |
| `scripts/v2/agentcore/provision.py` | Idempotent boto3 provisioner (Runtime/Gateways/Targets/Memory/Interpreter), SSM write, diff report, `--smoke` |
| `agent/agent.py` | Strands agent (reused as-is; receives `GATEWAYS_JSON`) |
| `agent/lambda/` | Agent tool Lambda sources (slice `aws_iam_mcp.py`, `flowmonitor.py`, `cross_account.py`; full fleet = P3) |

## Status / 상태

**P1f ✅ — A7 GREEN.**
- `provision` first run: 0 errors; smoke OK (runtime → security gateway → `list_roles` →
  real IAM data).
- Idempotent re-run: every resource `EXISTS`, Runtime `UPDATED` (the update path
  re-passes `roleArn` + `networkConfiguration` — proves the v1 quirk is handled, not a
  ConflictException).
- Intentional schema drift re-run: `update_gateway_target` (`UPDATED ... (schema drift)`)
  — a reconciliation path v1 never had.

Skeleton verified: 9 gateways incl. `awsops-v2-external-obs-gateway`, runtime ARN +
memory id in SSM (not `PENDING`), `lambda_arns = [iam-mcp, flow-monitor]`.

## Learnings & gotchas / 학습·함정

- **SSM reserved prefix** — SSM rejects any parameter path starting with `aws…`
  (reserved). Use `/ops/${project}/…` (hence `/ops/awsops-v2/agentcore/*`).
- **Gateway not yet READY** — a just-created gateway can make the first
  `create_gateway_target` throw `ValidationException`. Resolved by re-running: the
  provisioner is idempotent and re-runnable.
- **Underscore-only names** — Code Interpreter and Memory names allow underscores only,
  no hyphens (`awsops_v2_code_interpreter`, `awsops_v2_memory`).
- **Memory expiry** — `eventExpiryDuration` ≤ 365 days.
- **Runtime update** — must re-pass `roleArn` + `networkConfiguration` on every update.
- **Name collision avoidance** — gateways were renamed from v1's `awsops-{key}` to
  `awsops-v2-{key}-gateway` to isolate from v1 in the shared account.

**P3 backlog (DO NOT implement — list only):**
- Full Lambda tool fleet
- `section = routing`
- Right-docking chat UI
- An OpenCost install button (an ADR-029 mutating action running on the P2 worker backbone)

## Source / 출처

Consolidates three source docs (now archived):
- `docs/superpowers/archive/2026-05-31-awsops-v2-p1f-agentcore-provisioner.md` (primary)
- `docs/superpowers/archive/2026-05-31-custom-agents-skills-design.md`
- `docs/superpowers/archive/2026-05-31-adr-031-phase1.md`

Review: [`docs/reviews/v2-p1f-scope-architecture-review.md`](../../reviews/v2-p1f-scope-architecture-review.md)
(3-AI cross review — MID-minus scope decision, least-privilege roles, SSM-not-valueFrom).
