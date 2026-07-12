# AWSops v2 — Claude Context

> v2 architecture (Terraform · ECS Fargate · Aurora · AgentCore agents · async workers) is live on `main`, alongside the untouched v1.8.0 legacy app (`src/`, CDK/EC2/Steampipe, `/awsops` basePath). v1 rules (notably the `/awsops` fetch prefix and the Steampipe pg Pool) do **not** apply to v2. For v1 detail see `src/**/CLAUDE.md`.

## Overview
AWSops is a real-time AWS/Kubernetes operations dashboard. v2 rebuilt the v1 single-EC2 monolith as a Terraform-based MSA: private edge (CloudFront VPC Origin → internal ALB → Fargate), Cognito Lambda@Edge auth, Aurora durable state, AgentCore section agents (live AWS query), and an OOM-safe async worker tier.

## Architecture (v2)
- **IaC**: **Terraform** (CDK dropped). Single `terraform/v2/foundation/` root; **partial S3 backend** (`backend.hcl`, `awsops-v2-tfstate`, `use_lockfile` — no DynamoDB). TF ≥1.15, provider `~>6.0`.
- **Edge**: CloudFront(TLS) → **VPC Origin `https-only:443`** → **internal ALB HTTPS:443** (regional ACM) → HTTP → Fargate `awsops-v2-web:3000`. **No public ALB.** ALB SG allows 443 from the CloudFront managed SG `CloudFront-VPCOrigins-Service-SG` (VPC-CIDR-only → 504).
- **Auth**: Cognito User Pool + **Lambda@Edge** (`us-east-1`, python3.12, viewer-request). **RS256 JWKS signature verification** + iss/aud/token_use + OAuth `state` + **PKCE public client** (no secret). Domain `a-ops-v2-auth-*` ('aws' is a Cognito reserved word). **Login = self-hosted `/login` form** (ADR-042) — the BFF `POST /api/auth/login` calls the unsigned public `InitiateAuth(USER_PASSWORD_AUTH)` → mints `awsops_token` (id_token 12h). Unauthenticated requests are redirected to `/login` by the edge; the **Hosted UI PKCE flow (`/_callback`) is retained as a dark fallback**. Signout clears the cookie → `/login` (no Hosted UI `/logout` round-trip).
- **Web**: **Next.js 14 thin-BFF** (`web/`, standalone **arm64**, **root path — no basePath**). Routes: `/api/health` (public), `/api/stream` (SSE), `/api/db` (Aurora ping), `/api/jobs` (+`/[id]`, P2 async jobs). Heavy work is **enqueued** to the worker queue, not run inline.
- **Data**: **Aurora Serverless v2** (`awsops-v2-aurora`, **PG 17.9**, 0.5–4 ACU, KMS CMK, RDS-managed master secret). **ADR-030-based schema (baseline v9 frozen — table count per `data/schema.sql`)** + P2 `worker_jobs`. App uses **node-pg** (`web/lib/db.ts`). **A flag-gated Steampipe inventory sync (D1, `steampipe_enabled`) exists** — live queries still go through AgentCore MCP Lambda tools.
- **AI (AgentCore)**: Bedrock Sonnet 5 / **Opus 4.8** / Haiku 4.5 + AgentCore Runtime (Strands, reuses `agent/agent.py`) + **8 section gateways** (`awsops-v2-{network,container,data,security,cost,monitoring,iac,ops}-gateway`; external observability is the **Integrations axis** [ADR-039], not a 9th gateway — ADR-004 keeps the gateway count at **8**) + Memory + Code Interpreter. **Design: 8 section agents + 1 incident orchestrator** (replaces v1's 8 Gateways). Currently 2 read-only slices deployed (iam-mcp 14 tools→security, flow-monitor 1→network); full fleet is P3. **Config source of truth = SSM** `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}`.
- **Async workers (P2)**: web `POST /api/jobs` → `worker_jobs` (queued) + SQS → **ESM (kill-switch)** → dispatcher Lambda (idempotent on job_id) → **Step Functions Standard** Choice on `$.runtime` → RunLambda (short) **or** `ecs:runTask.sync` Fargate (long/OOM) → worker writes running/succeeded itself → on Catch, status_updater Lambda sets failed (SFN can't write VPC Aurora) → reaper (EventBridge 5min) reconciles stale.
- **EKS onboarding**: `configure.mjs` multi-select → `eks.tf` grants the web task role an **Access Entry + AmazonEKSViewPolicy** (cluster-scoped). kubeconfig auto-registration / query UI is P3.

## Status (by phase)
| Phase | Scope | State |
|-------|-------|-------|
| P1a–P1f | S3 backend, private edge, Cognito+Lambda@Edge auth, Aurora Serverless v2, web thin-BFF, EKS onboarding, AgentCore idempotent provisioner | ✅ |
| P2 | async worker backbone (SQS+SFN+Lambda/Fargate, `worker_jobs`) | ✅ W9 GREEN |
| **P3** | agent fleet + chat UI + EKS query (read-only). ~~OpenCost install button (ADR-029 mutating)~~ → **dropped (029 reversed)** | 🟡 partial (read-only shipped; mutating parts reversed) |
| **P4** | incident/ChatOps lifecycle + DevOps Agent federation | 🔜 backlog |

Live env: account `180294183052`, domain `awsops-v2.atomai.click`, reused mgmt-vpc (`vpc-06801144309cad7dc`, 10.254.0.0/16).

## Critical Rules (v2)

### Path / Web
- **Served at the root path (`/`) — no basePath.** v2 uses a dedicated domain. The v1 `/awsops/api/*` prefix rule does **not** apply → fetch `/api/*`.
- web is a **thin-BFF**: never run heavy/long/OOM-risk work inline — enqueue via `POST /api/jobs`.
- All components `export default`; production standalone build.

### Terraform discipline
- Change under `terraform/v2/foundation/`. **No `-auto-approve` on shared infra** — a saved-tfplan (`apply tfplan`) passes the auto-gate. Long applies (CloudFront, SG) are **run by the controller** (subagent idle-timeout).
- Gate large new features with count/flags: `agentcore_enabled`, `workers_enabled`, `steampipe_enabled` (inventory sync), `hybrid_routing_enabled` (ADR-038 chat routing) — all default false → `plan` = No changes, $0.
- **SG `description` is immutable** — changing it forces a SG replace that hangs on the attached ALB. Do ingress changes in-place, keep the description verbatim.
- **arm64 required** for web/agent/worker images.

### Data / Config
- App state lives in **Aurora** (node-pg), not `data/*.json` (the v1 pattern). Schema: `terraform/v2/foundation/data/schema.sql` + `schema_migrations`.
- ECS `secrets` valueFrom (Aurora secret) needs **execution-role** perms (not the task role), else `ResourceInitializationError`.
- AgentCore config: **SSM is the source of truth** (provision.py writes → web BFF reads at runtime). No valueFrom (avoids the race).

### Container / Deploy
- **Deploying Next.js standalone in a container: set `HOSTNAME=0.0.0.0` as a runtime env** (task def `environment`) — an image ENV is not enough (ECS overwrites HOSTNAME with the ENI IP → app binds only the ENI IP, not 0.0.0.0/loopback → healthCheck UNHEALTHY).
- **Fargate worker Dockerfile must use `CMD` (not ENTRYPOINT)** — SFN `containerOverrides.command` replaces CMD but is appended to an exec-form ENTRYPOINT → argv doubles → argparse dies.
- Container + target-group health path must match the app (`/api/health`) or the circuit breaker loops.

### Operational note
- **Concurrent sessions switch branches often** (docs-site deploys, etc.). Verify `git branch --show-current` before working. Uncommitted changes can be lost to an external reset/checkout — **commit in small units immediately**.

## Key Files

### Terraform (`terraform/v2/foundation/`)
- `network.tf` — new VPC or reuse existing (`create_network` flag)
- `edge.tf` — CloudFront + VPC Origin + internal ALB + ACM
- `auth.tf` + `edge-lambda/cognito_edge.py.tftpl` — Cognito + Lambda@Edge (RS256)
- `data.tf` + `data/schema.sql` — Aurora Serverless v2 + ADR-030-based schema (baseline v9 frozen — table count per `data/schema.sql`)
- `workload.tf` — ECS cluster/service/task (web)
- `ecr.tf` — dual-tier ECR (dev-private + prod-public)
- `ai.tf` — AgentCore ECR + IAM role + agent Lambda slice + SSM (all `agentcore_enabled`-gated)
- `workers.tf` — SQS + ESM + dispatcher/worker/status_updater/reaper Lambda + Step Functions + Fargate worker (all `workers_enabled`-gated)
- `eks.tf` — `for_each onboard_eks_clusters` Access Entry + View policy
- `variables.tf` / `outputs.tf` / `providers.tf` / `backend.tf`

### Scripts (`scripts/v2/`)
- `configure.mjs` — interactive TUI (VPC/domain/bucket/EKS → `terraform.tfvars` + `backend.hcl`)
- `deploy.mjs` — web: login→buildx arm64 push→ECS force-new-deployment→wait stable→smoke `/api/health`
- `agentcore.mjs` + `agentcore/{catalog.py,provision.py}` — arm64 agent image + idempotent provisioner (Runtime/9 GW/Target/Memory/Interpreter; writes SSM)
- `workers.mjs` + `workers/{db,dispatcher,handlers,reaper,status_updater,worker_lambda,fargate_worker}.py + sfn.asl.json` — P2 worker backbone

### Web (`web/`)
- `app/api/{health,stream,db,jobs}/route.ts`, `app/api/jobs/[id]/route.ts` — thin-BFF routes
- `app/security/page.tsx` + `app/api/security/{route,refresh}` — security findings (Public S3 · Open SG · Unencrypted EBS · IAM MFA), derived in the BFF from `inventory_resources` (read-only); `s3_public_access` added as a sync_lambda SDK sync
- `app/compliance/page.tsx` + `app/api/compliance/{run,runs,runs/[id],benchmarks}` — CIS benchmark (Powerpipe Fargate worker `compliance` job → `compliance_runs`/`compliance_results` history). Both gated on `steampipe_enabled`
- `lib/db.ts` — shared Aurora node-pg pool (`getPool`)
- `app/layout.tsx`, `app/page.tsx`, `Dockerfile` (standalone arm64)

### Agent (`agent/`, reused v1 assets)
- `agent/agent.py` — Strands Agent (routes via `GATEWAYS_JSON` env; no EC2 build needed)
- `agent/lambda/*.py` — MCP tool Lambda sources (v2 uses the iam-mcp/flow-monitor slice in P1f; full fleet is P3)

## Deployment (Makefile)
```
make configure   # interactive TUI → terraform.tfvars + backend.hcl (auto-installs deps)
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation plan -out tfplan   # controller runs apply tfplan (shared infra)
make deploy      # web: arm64 build→ECR push→ECS rolling→wait stable→smoke /api/health
make agentcore   # arm64 agent image + idempotent AgentCore provisioner (--smoke to invoke). Run after apply
make workers     # arm64 worker image push (after apply with workers_enabled=true)
```

## v2 ↔ v1 key differences
| Aspect | v1 (`src/`) | v2 (`web/` + `terraform/v2/`) |
|--------|-------------|-------------------------------|
| IaC | CDK | Terraform (partial S3 backend) |
| Compute | single EC2 t4g.2xlarge | ECS Fargate (web/worker split) |
| Data | embedded Steampipe PG + `data/*.json` | Aurora Serverless v2 PG17 (+ AgentCore live query) |
| Path | `/awsops` basePath | root `/` (no basePath) |
| Edge | CloudFront → public ALB → EC2 | CloudFront VPC Origin → internal ALB → Fargate |
| AI shape | 8 Gateways, 11-route router | 9 section GW + 1 incident orchestrator (design) |
| Long jobs | in-process | SQS+SFN+Lambda/Fargate async workers |
| Auth verify | exp-only (edge) | RS256 JWKS + PKCE |

## Known Issues / Learnings (reuse-critical)
- **Edge 504→200**: CF→ALB must be TLS end-to-end (VPC Origin `https-only` + origin domain = public FQDN for SNI match), ALB HTTPS:443 + regional ACM, ALB SG allows 443 from `CloudFront-VPCOrigins-Service-SG`. VPC Origin protocol can't change in-place → `create_before_destroy` + `-replace`.
- **Aurora major upgrade (15→17.9)**: set exact minor (`17.9`) + `allow_major_version_upgrade` + `apply_immediately`, apply first (upgrade) → **then** add `lifecycle{ignore_changes=[engine_version]}` to both cluster and instance (absorbs future minor auto-upgrades). Pinning just "17" misbehaves on `aws_rds_cluster`.
- **SG description immutable** (see Terraform discipline) / **ECS secrets need execution-role** / **HOSTNAME=0.0.0.0 runtime env** / **Fargate worker CMD (not ENTRYPOINT)**.
- **AgentCore**: Gateway Targets via boto3 (`mcp.lambda` + `credentialProviderConfigurations`); a just-created GW not yet READY makes the first target create throw ValidationException → resolved by re-running (provisioner is idempotent/re-runnable). Code Interpreter/Memory names underscores-only; Memory `eventExpiryDuration` ≤365.
- **SSM reserved prefix**: paths starting with `aws...` are rejected → use `/ops/${project}/...`.
- **Agent cross-account self-assume trap**: v2 is single-account, but selecting the host account (`180294183052`) in chat made `agent.py` force `target_account_id=<host>` → tools self-assumed `arn:...:role/AWSopsReadOnlyRole` (v1 *target-account*-only, absent on the host) → AccessDenied (agent **mis-reported** it as "cross-account blocked"). Fix: `cross_account.get_role_arn()` returns `None` when target==host (use the exec role directly) + `agent.py effective_account_id()` blanks the host like `__all__` (defense-in-depth). Host resolved via `AWSOPS_HOST_ACCOUNT_ID` env → STS `GetCallerIdentity` fallback (cached). The real *other*-account assume path is unchanged. v1 unaffected (separate functions `awsops-*-mcp` py3.12 vs v2 `awsops-v2-agent-*` py3.11).

## ADR
`docs/decisions/ADR-*.md` (001–044). v2-relevant: **038** (Hybrid agent routing — regex fast-path + Haiku classifier + v2 prompt caching; **activation LIVE 2026-06-10**, gate hybrid 96.9% / +27.7pp PASSED; AgentCore Gateway semantic search deferred to P4; extends 033, integrates the 031 routing priority); **037** (v2 Foundation — Terraform + thin-BFF + async workers; **supersedes 024 in full + refines 030's mechanism**; fixes the Steampipe stance = no live Steampipe, flag-gated inventory sync only; Accepted 2026-06-10); **030** (ECS Fargate + Aurora — Aurora/dual-ECR *intent* holds; the 4-container/Service-Connect/CDK *mechanism* is superseded by 037); **029·031·032·033·034·035·036** — all v2 ADRs — **Accepted (2026-06-09) via multi-AI consensus** (029 reframed as a substrate-agnostic *controls* spec — mechanism deferred to 036's hybrid, six controls retained). **ADR-009 is superseded by 032** (correlation engine carried into 032's Triage). **024 is superseded by 037 for v2** (kept as v1 history). **Admin model in v2 = SSM + Cognito group** (`web/lib/admin.ts`, ADR-023 v2 note). **⛔ High-risk ADR reversal (2026-06-11, 3-AI consensus — `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`): 029+036 (mutating substrate), 031 Phase 3 (BYO-MCP), Phase 4 (mutating tools) = REVERSED (do-not-enable, flag-OFF frozen, dark code retained); 032 & 035 = DOWNGRADED (autonomous mitigation / H3a wiring dropped; read-only Triage/RCA + K8s diagnosis retained); 034 kept (KEPT — flag-OFF; currently reuses the frozen 029/036 substrate role, so decoupling onto a self-contained role must precede any activation — see the ADR-034 banner). → AWSops is a read-only ops dashboard + AI diagnosis; **AWS-resource mutation + autonomy stay permanently frozen (do-not-enable)**.** **Subsequent 039–043 (2026-06-13~15): multi-agent platform (039), governed external knowledge/comms writes (040), keystone re-scope (041), in-app login (042), Neptune graph option (043). **ADR-041 re-defines "read-only"**: the constraint = **AWS-resource mutation + autonomy** (SSM/infra/autonomous = permanently frozen), **NOT external DATA** → external observability read + external record/ticket/message write are permitted under governance (SSRF · Secrets · DLP/redaction · curation · human-gate · flag-OFF); BYO-MCP only as curated connectors, arbitrary form excluded. ⚠️ **ADR-041 is an owner-solo re-scope** — multi-AI panel review verdict **PARTIAL** (2026-06-16): the external-write *outcome* is legitimate (ratified by the ADR-040 panel), but the retroactive framing "the reversal was never about external-endpoints" contradicts the 2026-06-11 consensus text (which explicitly named external-endpoint/egress/SSRF as scope-creep) → ADR-041 should record this as an **owner-override**, not a "clarification" (addendum applied).** **No Proposed ADRs remain.** New ADR number = highest + 1 (currently 044). ADR index/correction notes: `docs/decisions/CLAUDE.md`.
