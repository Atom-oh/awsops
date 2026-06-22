<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: e19df89b6da9 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Gemini, an external reviewer — project context below.

# AWSops — Reviewer Context

Branch `feat/v2-architecture-design`. Reviews on this branch target **v2** (Terraform · ECS Fargate · Aurora · AgentCore agents · async workers). v1.8.0 (`src/`, CDK/EC2/Steampipe, `/awsops` basePath) is the **untouched legacy production app** — v1 rules do NOT apply to v2. A diff under `web/`, `terraform/v2/`, `agent/`, or `scripts/v2/` is v2; a diff under `src/` is v1.

## ⛔ Product posture (current truth = `docs/decisions/BASELINE.md`)
v2 = ops dashboard + AI diagnosis. **Current form = diagnosis + remediation *proposal* (read-only).** North star: operate AWS resources per the Well-Architected 6 pillars, safely.
- **FROZEN (do-not-enable, ADR-005):** AWS-resource mutation + autonomy (remediation substrate, BYO-MCP, mutating tools). Unfreezing needs a NEW ADR + multi-AI panel + dated owner-override — never a silent/doc-cleanup reinterpretation. Frozen substrate is retained **dark code** (regression = *enabling* it, not its presence).
- **GATED analysis-only (ADR-006):** incident lifecycle / RCA write-back / K8sGPT — read-only triage/RCA, no autonomous mitigation; flags default OFF (rca_writeback needs role decoupling first).
- **External DATA is NOT the freeze (ADR-007, keystone):** external observability read + governed external write (Slack/Notion/Jira — SSRF · Secrets · DLP/redaction · human-gate · flag-OFF) are allowed; BYO-MCP only as curated connectors. `diagnosis_notify` (SNS) is already LIVE; broad `integrations_write_enabled` stays GATED-OFF.
- **🚩 Flag any PR that enables mutation/autonomy/BYO-MCP** — e.g. sets `remediation_enabled=true`, flips a frozen flag, or wires the dark substrate live. The dark code exists intentionally (built-then-reversed); enabling it is the regression, not its presence.

## Stack / runtime
- **Web:** Next.js 14 thin-BFF (`web/`), standalone **arm64**, served at **root `/` — no basePath**. Routes `web/app/api/{health,stream,db,jobs}/route.ts` (+ `jobs/[id]`). Heavy/long/OOM work is **enqueued via `POST /api/jobs`**, never run inline. Fetch is `/api/*` (NOT `/awsops/api/*` — that v1 prefix is gone in v2).
- **Data:** Aurora Serverless v2 (PG 17.9) via **node-pg** (`web/lib/db.ts`, shared `getPool`). App state lives in Aurora, **not `data/*.json`** (that is the v1 pattern). Schema = `terraform/v2/foundation/data/schema.sql` + collision-free ULID migrations (`migrations/<ULID>_*.sql`, never append to schema.sql).
- **IaC:** Terraform (CDK dropped). Single root `terraform/v2/foundation/`, partial S3 backend (`backend.hcl`, no DynamoDB), TF ≥1.15, provider `~>6.0`.
- **Edge:** CloudFront(TLS) → VPC Origin `https-only:443` → internal ALB HTTPS:443 (regional ACM) → HTTP → Fargate `awsops-v2-web:3000`. **No public ALB.** ALB SG allows 443 from CloudFront managed SG `CloudFront-VPCOrigins-Service-SG` (VPC-CIDR-only → 504).
- **AI:** Bedrock **Sonnet 4.6 / Opus 4.8 / Haiku 4.5** + AgentCore (Strands, reuses `agent/agent.py`; routes via `GATEWAYS_JSON`). Live AWS queries go through **AgentCore MCP Lambda tools** (`agent/lambda/*.py`), never inline in the BFF. Config source-of-truth = **SSM** `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` (read at runtime; no ECS `valueFrom` to avoid a race).
- **Chat routing (ADR-038, LIVE):** regex fast-path → Haiku classifier fallback; prompt caching + temperature=0. Gated by `hybrid_routing_enabled`.
- **Async workers (P2):** `POST /api/jobs` → `worker_jobs` (queued) + SQS → ESM (kill-switch) → dispatcher Lambda (idempotent on job_id) → Step Functions → RunLambda (short) **or** `ecs:runTask.sync` Fargate (long/OOM) → worker writes running/succeeded itself → status_updater on Catch sets failed (SFN can't write VPC Aurora) → reaper (EventBridge 5min) reconciles stale. Files: `terraform/v2/foundation/workers.tf`, `scripts/v2/workers/`.

## Build · Test · Lint (copy-paste; do not invent)
```bash
# v2 web (cwd = web/) — package.json scripts: dev / build / start / test (no lint script)
cd web && npm ci && npm run build       # next build (standalone)
cd web && npx vitest run                 # web test suite (vitest); ~94 *.test.ts(x)

# Terraform (controller runs apply on shared infra; agents do NOT auto-approve)
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out tfplan   # controller runs `apply tfplan`

# Makefile (run after terraform apply where noted)
make configure   # interactive TUI → terraform.tfvars + backend.hcl
make migrate     # apply pending ULID migrations (advisory-locked; DRY_RUN=1 to preview)
make deploy      # migrate → buildx arm64 → ECR push → ECS roll → wait stable → smoke /api/health
make agentcore   # arm64 agent image + idempotent AgentCore provisioner (--smoke to invoke)
make workers     # arm64 worker image push (after apply with workers_enabled=true)
```
Note: the repo-root `package.json` (`build`/`lint`/`test`) belongs to the **v1** app; the **v2** web app lives under `web/` and has no `lint` script. `next build` fails on app-level type errors but `*.test.ts(x)` type noise is non-blocking.

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
- Edge auth = Cognito + Lambda@Edge **RS256 JWKS verification** + iss/aud/token_use + OAuth `state` + PKCE public client (no client secret). In-app login = self-hosted `/login` + `POST /api/auth/login` (unsigned public Cognito `InitiateAuth USER_PASSWORD_AUTH`; ADR-042); Hosted-UI PKCE `/_callback` is a retained dark fallback. `/api/health` is the only intentionally public route.

## Review checklist
1. **Posture:** no mutation/autonomy/BYO-MCP enabled (029/036 reversed; flag any PR that turns it on). External write, if any, must satisfy ADR-040 governance (SSRF, Secrets Manager, DLP/redaction, human-gate, flag-OFF).
2. **Edge/auth:** RS256 JWKS verification intact (no decode-only / exp-only regression); no new public route bypass; secrets on execution role; nothing sensitive committed.
3. **Thin-BFF:** heavy/long/OOM work enqueued via `/api/jobs`, not inline; Aurora via `getPool`; AgentCore ARNs from SSM; admin via `web/lib/admin.ts`.
4. **Terraform:** changes under `terraform/v2/foundation/`; large features flag-gated; SG description unchanged; no `0.0.0.0/0`, no `Principal:*`; no `-auto-approve` baked in.
5. **Containers:** arm64; `HOSTNAME=0.0.0.0` runtime env; Fargate worker `CMD`; container + TG health path = `/api/health`.
6. **v2 vs v1:** fetch `/api/*` (no `/awsops` prefix); state in Aurora not `data/*.json`; new tables as ULID migration files.
7. **Gateway count:** doctrine vs as-built mismatch — see below; flag either way.

## Gateway count — flag either way (NOT a false-positive)
AgentCore gateways (ADR-004, RESOLVED): **9 gateways are provisioned** (8 sections network/container/data/security/cost/monitoring/iac/ops + `external-obs`) and **agent.py routes 8 section agents**. State it as **"9 provisioned / 8 agent routes"** — different axes, not a contradiction.

## Known false-positives (do NOT flag)
- **Model ids:** Opus is **4.8**, Sonnet is **4.6** (no `-v1` suffix). Any "Opus 4.6" / "17-route router" text is stale v1 — the current code is correct.
- **Dark code is intentional:** ADRs use a supersession/reversal model; a "reversed/frozen but code present" slice (e.g. mutation substrate in `workers.tf`, ADR-031 Phase 3/4) is deliberately retained dark code, NOT dead code. The regression is *enabling* it, not its presence.
- Fetch to `/api/...` without an `/awsops` prefix is correct in v2 (basePath dropped).
- `agentcore_enabled` / `workers_enabled` / `steampipe_enabled` / `hybrid_routing_enabled` defaulting false (so `plan` = No changes) is intentional, not dead config.
- Chat classifier calling Bedrock Haiku for routing (ADR-038) is intentional in v2 — it supersedes v1's "Sonnet-only router" rule; regex-first, golden-set-gated.
- Flag-gated Steampipe Fargate+Lambda inventory sync (default off) is the *only* sanctioned Steampipe in v2 — a batch loader into Aurora, not a live-query service; not a contradiction of "no live Steampipe" (live queries go through AgentCore MCP tools).
- Exact Aurora minor `17.9` + `lifecycle{ignore_changes=[engine_version]}` on cluster AND instance is deliberate (absorbs minor auto-upgrades), not a drift bug.
- `CloudFront-VPCOrigins-Service-SG` 443 ingress on the ALB SG is required (VPC-CIDR-only causes 504).
- SFN `.sync` briefly showing RUNNING after the worker wrote `succeeded` is expected (task-stop polling lag); the `worker_jobs` ledger is the source of truth.
- web `package.json` having no `lint` script (only dev/build/start/test) is expected; lint lives in the v1 root package.
