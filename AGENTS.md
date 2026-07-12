<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: b631319c7b27 · generated-at: 2026-07-02 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# AWSops — Reviewer Context

Branch `feat/v2-architecture-design`. Reviews on this branch target **v2** (Terraform · ECS Fargate · Aurora · AgentCore agents · async workers). v1.8.0 (`src/`, CDK/EC2/Steampipe, `/awsops` basePath) is **being decommissioned in stages per ADR-016** (`docs/runbooks/v1-decommission.md`) — v1 rules do NOT apply to v2. A diff under `web/`, `terraform/v2/`, `agent/`, or `scripts/v2/` is v2; a diff under `src/` is v1.

## ⛔ Product posture (current truth = `docs/decisions/BASELINE.md`)
v2 = ops dashboard + AI diagnosis. **Current form = diagnosis + remediation *proposal* (read-only).** North star: operate AWS resources per the Well-Architected 6 pillars, safely.
- **FROZEN (do-not-enable, ADR-005):** AWS-resource mutation + autonomy (remediation substrate, BYO-MCP, mutating tools). Unfreezing needs a NEW ADR + multi-AI panel + dated owner-override — never a silent/doc-cleanup reinterpretation. Frozen substrate is retained **dark code** (regression = *enabling* it, not its presence).
  - **One granted exception exists: ADR-015** (`secret_rotation_redeploy_enabled`, default-off) — owner-override by 오준석, 2026-07-01. Scope is exactly one call: `ecs:UpdateService(forceNewDeployment)` **restarting** the host's own web service on its own Aurora master-secret rotation event (same image/task-def — not a code deploy), IAM scoped to that one service ARN, secret-id fail-closed. Do NOT flag this specific path as a fresh FROZEN violation — it is the one ratified carve-out. Any OTHER mutating/autonomous path (a new flag, a broader IAM grant, a different trigger, actual code/image changes) is still a FROZEN violation and should be flagged.
- **GATED analysis-only (ADR-006):** incident lifecycle / RCA write-back / K8sGPT — read-only triage/RCA, no autonomous mitigation; flags default OFF (rca_writeback needs role decoupling first).
- **External DATA is NOT the freeze (ADR-007, keystone):** external observability read + governed external write (Slack/Notion/Jira — SSRF · Secrets · DLP/redaction · human-gate · flag-OFF) are allowed; BYO-MCP only as curated connectors. `diagnosis_notify` (SNS) is already LIVE; broad `integrations_write_enabled` stays GATED-OFF.
- **🚩 Flag any PR that enables mutation/autonomy/BYO-MCP** — e.g. sets `remediation_enabled=true`, flips a frozen flag, or wires the dark substrate live. The dark code exists intentionally (built-then-reversed); enabling it is the regression, not its presence.

## Stack / runtime
- **Web:** Next.js 14 thin-BFF (`web/`), standalone **arm64**, served at **root `/` — no basePath**. Routes `web/app/api/{health,stream,db,jobs}/route.ts` (+ `jobs/[id]`). Heavy/long/OOM work is **enqueued via `POST /api/jobs`**, never run inline. Fetch is `/api/*` (NOT `/awsops/api/*` — that v1 prefix is gone in v2).
- **Data:** Aurora Serverless v2 (PG 17.9) via **node-pg** (`web/lib/db.ts`, shared `getPool`). App state lives in Aurora, **not `data/*.json`** (that is the v1 pattern). Schema = `terraform/v2/foundation/data/schema.sql` + collision-free ULID migrations (`migrations/<ULID>_*.sql`, never append to schema.sql).
- **IaC:** Terraform (CDK dropped). Single root `terraform/v2/foundation/`, partial S3 backend (`backend.hcl`, no DynamoDB), TF ≥1.15, provider `~>6.0`.
- **Edge:** CloudFront(TLS) → VPC Origin `https-only:443` → internal ALB HTTPS:443 (regional ACM) → HTTP → Fargate `awsops-v2-web:3000`. **No public ALB.** ALB SG allows 443 from CloudFront managed SG `CloudFront-VPCOrigins-Service-SG` (VPC-CIDR-only → 504).
- **AI:** Bedrock **Sonnet 4.6 / Opus 4.8 / Haiku 4.5** + AgentCore (Strands, reuses `agent/agent.py`; routes via `GATEWAYS_JSON`). Live AWS queries go through **AgentCore MCP Lambda tools** (`agent/lambda/*.py`), never inline in the BFF. Config source-of-truth = **SSM** `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` (read at runtime; no ECS `valueFrom` to avoid a race).
- **Chat routing (ADR-038, LIVE):** regex fast-path (`web/lib/route.ts`, **first-match-wins ordered RULES**) → Haiku classifier fallback (`web/lib/classifier.ts`); prompt caching + temperature=0. Gated by `hybrid_routing_enabled`. **9 routed sections** incl `observability` (external-obs: Prometheus + ClickHouse) — see Gateway section.
- **Datasource connectors:** the v2 datasource family (`agent/lambda/{clickhouse,prometheus,loki,tempo,mimir,opensearch}_mcp.py`) all import the shared `datasource_http.py`; that file **must be bundled into each Lambda zip** (ai.tf `dynamic source`) or the Lambda dies with `Runtime.ImportModuleError: No module named 'datasource_http'`.
- **Async workers (P2):** `POST /api/jobs` → `worker_jobs` (queued) + SQS → ESM (kill-switch) → dispatcher Lambda (idempotent on job_id) → Step Functions → RunLambda (short) **or** `ecs:runTask.sync` Fargate (long/OOM) → worker writes running/succeeded itself → status_updater on Catch sets failed (SFN can't write VPC Aurora) → reaper (EventBridge 5min) reconciles stale. Files: `terraform/v2/foundation/workers.tf`, `scripts/v2/workers/`.

## Build · Test · Lint (copy-paste; do not invent)
```bash
# v2 web (cwd = web/) — package.json scripts: dev / build / start / test (no lint script)
cd web && npm ci && npm run build       # next build (standalone)
cd web && npx vitest run                 # web test suite (vitest)

# agent (Python) — MCP Lambda sources + Strands entrypoint
cd agent && python3 -m pytest test_agent.py -q

# Terraform (controller runs apply on shared infra; agents do NOT auto-approve)
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out tfplan   # controller runs `apply tfplan`

# Makefile (run after terraform apply where noted)
make migrate     # apply pending ULID migrations (advisory-locked; DRY_RUN=1 to preview)
make deploy      # migrate → buildx arm64 → ECR push → ECS roll → wait stable → smoke /api/health
make agentcore   # arm64 agent image + idempotent AgentCore provisioner (builds the agent image; does NOT deploy the MCP Lambdas — those are terraform)
make workers     # arm64 worker image push (after apply with workers_enabled=true)
```
Note: the repo-root `package.json` belongs to the **v1** app; the **v2** web app lives under `web/` and has no `lint` script. `next build` fails on app-level type errors but `*.test.ts(x)` type noise is non-blocking. **MCP Lambda code (`agent/lambda/*.py`) ships via `terraform apply`, not `make agentcore`** — a stale Lambda after a code change usually means apply wasn't run.

## BANNED PATTERNS (enforce in review)
- **AWS security:** no `0.0.0.0/0` ingress; no IAM `Principal: "*"` / wildcard-action without a scoped condition; **no secrets in env/code/IaC** (use Secrets Manager / SSM).
- **No AWS-resource mutation or autonomy** — permanently frozen (see Product posture). Flag any PR that revives it.
- **SG `description` is immutable** — changing it forces a SG replace that hangs on the attached ALB. Do ingress changes in-place; keep the description verbatim.
- **arm64 required** for web/agent/worker images (`buildx --platform linux/arm64`).
- **`HOSTNAME=0.0.0.0` must be a runtime env** (task def `environment`) for Next standalone — an image ENV is insufficient (ECS overwrites it with the ENI IP → health check UNHEALTHY).
- **Fargate worker Dockerfiles use `CMD`, not exec-form `ENTRYPOINT`** — SFN `containerOverrides.command` is appended to ENTRYPOINT → argv doubles → argparse dies.
- **ECS `secrets` valueFrom needs execution-role perms** (not the task role) — else `ResourceInitializationError`.
- **No `-auto-approve` on shared infra** — a saved `tfplan` (`apply tfplan`) passes the gate; long applies are run by the controller.
- **Flag-gate large new features** (`agentcore_enabled`, `workers_enabled`, `steampipe_enabled`, `hybrid_routing_enabled` — all default false → `plan` = No changes, $0).

## Naming / conventions
- Components `export default`. Resource names `awsops-v2-*`; AgentCore gateways `awsops-v2-{key}-gateway`; SSM under `/ops/awsops-v2/...` (an `aws...` prefix is SSM-reserved and rejected).
- Admin authority in v2 = **Cognito admin group OR an SSM-parameter email allowlist** (`web/lib/admin.ts`, fail-closed), NOT `data/config.json` `adminEmails` (that is v1; ADR-023 v2 note).
- Edge auth = Cognito + Lambda@Edge **RS256 JWKS verification** + iss/aud/token_use + OAuth `state` + PKCE public client (no client secret). In-app login = self-hosted `/login` + `POST /api/auth/login` (unsigned public Cognito `InitiateAuth USER_PASSWORD_AUTH`; ADR-042); Hosted-UI PKCE `/_callback` is a retained dark fallback. Public (unauthenticated) routes per ADR-002: `/api/health`, `/login`, `/api/auth/login`, `/api/auth/signout`, `/icon.svg`, `/_next/static/*`, `/api/incidents/webhook`.

## Review checklist
1. **Posture:** no mutation/autonomy/BYO-MCP enabled (ADR-005 frozen, do-not-enable; flag any PR that turns it on). External write, if any, must satisfy ADR-007 governance (SSRF, Secrets Manager, DLP/redaction, human-gate, flag-OFF). Current truth = `docs/decisions/BASELINE.md`.
2. **Edge/auth:** RS256 JWKS verification intact (no decode-only / exp-only regression); no new public route bypass; secrets on execution role; nothing sensitive committed.
3. **Thin-BFF:** heavy/long/OOM work enqueued via `/api/jobs`, not inline; Aurora via `getPool`; AgentCore ARNs from SSM; admin via `web/lib/admin.ts`.
4. **Terraform:** changes under `terraform/v2/foundation/`; large features flag-gated; SG description unchanged; no `0.0.0.0/0`, no `Principal:*`; no `-auto-approve` baked in.
5. **Containers:** arm64; `HOSTNAME=0.0.0.0` runtime env; Fargate worker `CMD`; container + TG health path = `/api/health`.
6. **v2 vs v1:** fetch `/api/*` (no `/awsops` prefix); state in Aurora not `data/*.json`; new tables as ULID migration files.
7. **Routing:** golden-routing fixture labels must match `route.ts` RULES order (first-match-wins — a generic keyword like `쿼리`/`metric` can be stolen by an earlier `data`/`monitoring` rule); the `observability` chat key must resolve to a real gateway at runtime (see Gateway section).

## Gateway routing & count (ADR-004, amended 2026-06-24)
**9 gateways provisioned / 9 agent routes.** The 8 section gateways (network/container/data/security/cost/monitoring/iac/ops) + **`external-obs`** (the Integrations axis, ADR-039) which is now a **routed** section hosting the external-observability connectors **Prometheus + ClickHouse** (Loki/Tempo/Mimir stay on `monitoring` for now). The chat section key is **`observability`**, aliased to the `external-obs` gateway in `agent.py` (`_GATEWAY_ALIAS`).
- **Runtime key gotcha:** `_discover_gateways` derives a gateway's short key via `name.replace("awsops-","").replace("-gateway","")`. While v1 and v2 gateways coexist, a v2 gateway `awsops-v2-external-obs-gateway` yields key **`v2-external-obs`**, not `external-obs`. `_resolve_gateway_key` therefore tries the canonical key AND a `v2-`-prefixed variant (and resolves DEFAULT_GATEWAY the same tolerant way — never a bare `GATEWAYS[DEFAULT_GATEWAY]` eager index, which KeyErrors when `ops` is absent under v2-only discovery). The `v2-` fallback is a coexistence shim to drop at the v2→main cutover.

## Known false-positives (do NOT flag)
- **Model ids:** Opus is **4.8**, Sonnet is **4.6** (no `-v1` suffix). Any "Opus 4.6" / "17-route router" text is stale v1 — the current code is correct.
- **Dark code is intentional:** a "frozen but code present" slice (e.g. mutation substrate in `remediation.tf`/`workers.tf`, ADR-005 frozen tier) is deliberately retained dark code, NOT dead code. The regression is *enabling* it, not its presence.
- Fetch to `/api/...` without an `/awsops` prefix is correct in v2 (basePath dropped).
- `agentcore_enabled` / `workers_enabled` / `steampipe_enabled` / `hybrid_routing_enabled` defaulting false (so `plan` = No changes) is intentional, not dead config.
- Chat classifier calling Bedrock Haiku for routing (ADR-038) is intentional in v2 — it supersedes v1's "Sonnet-only router" rule; regex-first, golden-set-gated. The golden `golden-routing.test.ts` baseline is **informational, not a gate** (it only asserts a 0.3–0.85 band); per-case regex misses for LLM-routed ambiguous queries are expected.
- The `observability` chat key NOT being a literal `agent.py` GATEWAYS key is fine — `_GATEWAY_ALIAS` maps it to `external-obs`/`v2-external-obs` and `SKILL_BASE["observability"]` supplies the persona; there is no silent `ops` fallback.
- Flag-gated Steampipe Fargate+Lambda inventory sync (default off) is the *only* sanctioned Steampipe in v2 — a batch loader into Aurora, not a live-query service (live queries go through AgentCore MCP tools).
- Exact Aurora minor `17.9` + `lifecycle{ignore_changes=[engine_version]}` on cluster AND instance is deliberate (absorbs minor auto-upgrades), not a drift bug.
- `CloudFront-VPCOrigins-Service-SG` 443 ingress on the ALB SG is required (VPC-CIDR-only causes 504).
- SFN `.sync` briefly showing RUNNING after the worker wrote `succeeded` is expected (task-stop polling lag); the `worker_jobs` ledger is the source of truth.
- web `package.json` having no `lint` script (only dev/build/start/test) is expected; lint lives in the v1 root package.
