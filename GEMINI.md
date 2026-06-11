<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 2a1fa98c82bc · generated-at: 2026-06-10 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->
> You are Gemini, an external reviewer — project context below.

# AWSops v2 — Reviewer Context

Branch `feat/v2-architecture-design`. Reviews on this branch target **v2** (Terraform · ECS Fargate · Aurora · AgentCore agents · async workers). v1.8.0 (`src/`, CDK/EC2/Steampipe, `/awsops` basePath) is the **untouched legacy app** — its rules do NOT apply to v2.

## Stack
- **IaC**: Terraform (CDK dropped — see ADR-037, which supersedes the ADR-024 CDK split). Root `terraform/v2/foundation/`; partial S3 backend (`backend.hcl`, `awsops-v2-tfstate`, `use_lockfile`, no DynamoDB). TF ≥1.15, provider `~>6.0`.
- **Web**: Next.js 14 thin-BFF (`web/`, standalone arm64, **root path — no basePath**). Routes `/api/{health,stream,db,jobs,chat}` (+ `/api/jobs/[id]`). node-pg to Aurora via `web/lib/db.ts`.
- **Data**: Aurora Serverless v2 (PG 17.9). ADR-030 7-table schema + `worker_jobs`. **No *live* Steampipe in v2** — live AWS queries go through AgentCore MCP Lambda tools; the only Steampipe is a **flag-gated warm inventory-sync** batch (`var.steampipe_enabled`, default off, `steampipe.tf` → Aurora), NOT a Service-Connect daemon (ADR-037 §Decision #4).
- **AI**: Bedrock Sonnet 4.6 / Opus 4.8 / Haiku 4.5 + AgentCore (9 section gateways + 1 incident orchestrator design; reuses `agent/agent.py`). Config source of truth = SSM `/ops/awsops-v2/agentcore/*`. (Opus is 4.8, no `-v1` suffix; any "Opus 4.6"/"17-route" text is stale v1.)
- **Async workers**: web `/api/jobs` → SQS → ESM → dispatcher Lambda → Step Functions → RunLambda or Fargate (`ecs:runTask.sync`) → status_updater on Catch → reaper. Files in `terraform/v2/foundation/workers.tf` + `scripts/v2/workers/`. This P2 backbone is also the single mutation control-plane/ledger (ADR-036).

## Build · Test · Lint
```bash
make configure                                                  # TUI → terraform.tfvars + backend.hcl
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out tfplan       # apply via saved plan only
make deploy        # web: arm64 build → ECR push → ECS rolling → smoke /api/health
cd web && npm run build                                         # Next.js standalone build
```
No unit-test harness for web; verification = clean `terraform validate`/`plan` and a clean web build. A diff that doesn't `validate`/build must not be approved.

## Architectural boundaries (what may import what)
- **web is a thin-BFF**: heavy/long/OOM-risk work must be **enqueued** via `POST /api/jobs`, never run inline in a request handler. A handler doing heavy compute/long AWS calls inline is a defect.
- App state lives in **Aurora via node-pg** (`web/lib/db.ts` `getPool`), not in `data/*.json` (the v1 pattern). Schema changes go through `terraform/v2/foundation/data/schema.sql` + `schema_migrations`.
- AgentCore config is read from **SSM** at runtime — never hardcode runtime/memory/interpreter ARNs or account IDs.
- Admin authority in v2 = **Cognito `ADMIN_GROUP` group OR an SSM-parameter email allowlist** (`web/lib/admin.ts`, fail-closed), NOT `data/config.json` `adminEmails` (that's v1; ADR-023 v2 note). References to "the ADR-023 adminEmails gate" mean this v2 gate.
- Mutating actions (ADR-029 controls + ADR-036 hybrid substrate) run on the P2 worker backbone + SSM Automation/Change Manager — never a separate per-action SFN stack, never inline from web. Recommendation-only by default; execution is gated + kill-switchable.
- Terraform: all infra under `terraform/v2/foundation/`. Large features must be **flag-gated** (`agentcore_enabled`, `workers_enabled`, `steampipe_enabled` — all default false → `plan` = No changes).

## Naming / conventions
- Components `export default`. Web served at **root `/`** — fetch `/api/*` (NOT `/awsops/api/*`; that v1 rule is gone in v2).
- **arm64** for all images (web/agent/worker): `buildx --platform linux/arm64`.
- Resource names `awsops-v2-*`; AgentCore gateways `awsops-v2-{key}-gateway`; SSM under `/ops/awsops-v2/...` (an `aws...` prefix is SSM-reserved and rejected).

## Security rules
- Edge auth = Cognito + Lambda@Edge with **RS256 JWKS verification** + iss/aud/token_use + OAuth `state` + PKCE public client (no client secret). A change that weakens edge verification to decode-only/exp-only is a security regression.
- `/api/health` is the only intentionally public route; everything else sits behind edge auth. New public bypasses are defects unless justified.
- ECS `secrets` valueFrom (Aurora secret) must be on the **execution role**, not the task role.
- Mutating-action executors get **per-action IAM roles** (SSM `AutomationAssumeRole` per runbook / per-action task role for P2 code) — never a shared broad worker role; 4-eyes/approver ≠ requester where required.
- Never commit secrets, account IDs, tfvars, or `backend.hcl` values.

## Review checklist
1. `terraform validate` + clean `plan`; web builds. New infra is flag-gated (`agentcore_enabled`/`workers_enabled`/`steampipe_enabled`).
2. No `-auto-approve` on shared infra; applies go through a saved tfplan.
3. SG `description` unchanged (it's immutable → forces a replace that hangs on the ALB); ingress edits in-place.
4. Next.js standalone containers set `HOSTNAME=0.0.0.0` as a **runtime env** (task def), not just an image ENV.
5. Fargate worker Dockerfiles use `CMD` (not exec-form ENTRYPOINT) so SFN `containerOverrides.command` doesn't double argv.
6. web stays thin-BFF (heavy work enqueued); Aurora access via `getPool`; AgentCore ARNs from SSM; admin via `web/lib/admin.ts`.
7. Auth verification stays RS256 JWKS; no new public routes; secrets on execution role; mutations gated through P2/SSM; nothing sensitive committed.

## Known false-positives (do NOT flag)
- Fetch to `/api/...` without an `/awsops` prefix is correct in v2 (basePath was dropped).
- `agentcore_enabled`/`workers_enabled`/`steampipe_enabled` defaulting to false (so `plan` = No changes) is intentional, not dead config.
- A flag-gated Steampipe Fargate+Lambda inventory-sync (default off) is the *only* sanctioned Steampipe in v2 — it is a batch loader into Aurora, not a live-query service; not a contradiction of "no live Steampipe".
- Exact Aurora minor `17.9` + `lifecycle{ignore_changes=[engine_version]}` on cluster AND instance is deliberate (absorbs minor auto-upgrades) — not a drift bug.
- `CloudFront-VPCOrigins-Service-SG` 443 ingress on the ALB SG is required (VPC-CIDR-only causes 504).
- SFN `.sync` briefly showing RUNNING after the worker wrote `succeeded` is expected (task-stop polling lag); the `worker_jobs` ledger is the source of truth.
- ADR-030's body describing 4 containers / Service-Connect Steampipe / CDK is **historical** — ADR-037 is the authoritative v2 topology. Don't review v2 against ADR-030's mechanism.

## Note
The repo also contains v1 (`src/`, `infra-cdk/`, Steampipe, `/awsops`). If a diff is purely under `src/`/`infra-cdk/`, review it against v1 conventions (pg Pool, `account_id` columns, `/awsops` prefix) instead — but this branch's work is v2.
