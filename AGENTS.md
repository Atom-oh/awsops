<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 2ad982d01c2c · generated-at: 2026-08-12 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# AWSops — Reviewer Context

**v2 is live on `main`** (Terraform · ECS Fargate · Aurora · AgentCore agents · async workers). v1.8.0 (`src/`, CDK/EC2/Steampipe, `/awsops` basePath) is decommissioned per ADR-016 — its code left the tree 2026-07-12 (`git tag v1-pre-code-removal-20260712`); only stopped AWS infra remains until final teardown. v1 rules do NOT apply to v2. A diff under `web/`, `terraform/v2/`, `agent/`, or `scripts/v2/` is v2.

**ADR numbering:** current truth = `docs/decisions/BASELINE.md` + consolidated ADRs **001–018** (new ADR = highest+1, BASELINE updated in the same PR). Legacy ADRs 001–046 are out of tree (tag `adr-legacy-2026-06-22`); docs cite them as `ADR-0NN[legacy 0XX]` — the live number is authoritative, resolve via `docs/decisions/ADR-MAPPING.md`, never read the tag bodies.

## ⛔ Product posture (current truth = `docs/decisions/BASELINE.md`)
v2 = ops dashboard + AI diagnosis. **Current form = diagnosis + remediation *proposal* (read-only).**
- **FROZEN (do-not-enable, ADR-005):** AWS-resource mutation + autonomy (remediation substrate, arbitrary BYO-MCP, mutating tools). Unfreezing needs a NEW ADR + multi-AI panel + dated owner-override. Frozen substrate is retained **dark code** (regression = *enabling* it, not its presence).
  - **One granted exception: ADR-015** (`secret_rotation_redeploy_enabled`, default-off, owner-override 2026-07-01) — exactly one call: `ecs:UpdateService(forceNewDeployment)` restarting the host's own web service on its own Aurora master-secret rotation event (same image/task-def — not a code deploy), IAM scoped to one service ARN, secret-id fail-closed (`terraform/v2/foundation/secret-rotation.tf`). Do NOT flag this specific path; any OTHER mutating/autonomous path is still a FROZEN violation.
- **GATED analysis-only (ADR-006):** incident lifecycle / RCA write-back / K8sGPT — read-only triage/RCA, no autonomous mitigation; flags default OFF.
- **External DATA is NOT the freeze (ADR-007, keystone):** external observability read + governed external write are allowed under governance; curated connectors only (arbitrary `custom_mcp` dropped). `diagnosis_notify_enabled` (SNS email) is the **one LIVE external write**; broad `integrations_write_enabled` stays GATED-OFF. Curated official MCP presets = ADR-017 (vendor-hosted 3 only, runtime fail-closed tool allowlist, GATED; ClickHouse stdio embed FROZEN).
- **🚩 Flag any PR that enables mutation/autonomy/BYO-MCP** — flips a frozen flag or wires the dark substrate live.

## Stack / runtime
- **Web:** Next.js 14 thin-BFF (`web/`), standalone **arm64**, root path `/` — no basePath. Fetch is `/api/*` (never `/awsops/api/*`). Heavy/long/OOM work is enqueued to the worker tier — BUT the generic `POST /api/jobs` accepts **only allowlisted noop job types**; domain jobs (`report`, `compliance`, `datasource_index`, `insight`, `incident_stage`) are submitted only via their ownership-checked dedicated routes (`/api/diagnosis`, `/api/compliance/run`, admin-only triggers — IDOR fix, PR #195/ADR-009).
- **Data:** Aurora Serverless v2 (PG 17.9) via node-pg (`web/lib/db.ts`, shared `getPool`). App state in Aurora, **not `data/*.json`** (v1 pattern). Schema = `terraform/v2/foundation/data/schema.sql` + ULID migrations (`migrations/<ULID>_*.sql`, never append to schema.sql).
- **IaC:** Terraform only (CDK dropped). Single root `terraform/v2/foundation/`, partial S3 backend (`backend.hcl`, no DynamoDB), TF ≥1.15, provider `~>6.0`.
- **Edge:** CloudFront(TLS) → VPC Origin `https-only:443` → internal ALB HTTPS:443 (regional ACM) → HTTP → Fargate `awsops-v2-web:3000`. **No public ALB.** ALB SG allows 443 from `CloudFront-VPCOrigins-Service-SG` (VPC-CIDR-only → 504).
- **AI:** Bedrock Sonnet 5 / Opus 4.8 / Haiku 4.5 + AgentCore (Strands, `agent/agent.py`, routes via `GATEWAYS_JSON`). Live AWS queries via AgentCore MCP Lambda tools (`agent/lambda/*.py`), never inline in the BFF. Config source of truth = SSM `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` (runtime read; no ECS `valueFrom`).
- **Chat routing (ADR-003[legacy 038], LIVE):** regex fast-path (`web/lib/route.ts`, first-match-wins RULES) → Haiku classifier fallback; gated by `hybrid_routing_enabled`. **16 routing keys are registered** = 9 gateway-routed sections + `aws-data` + 6 auto-collect collectors (`web/lib/collectors/`); the latter 7 are web-BFF-local (not via AgentCore) and their Steampipe-backed execution is hard-disabled (see Known false-positives) — they fail-open to normal routing at runtime.
- **Datasource connectors:** `agent/lambda/{clickhouse,prometheus,loki,tempo,mimir,opensearch}_mcp.py` all import shared `datasource_http.py`; it must be bundled into each Lambda zip (ai.tf `dynamic source`) or the Lambda dies with `Runtime.ImportModuleError`.
- **Async workers (P2):** enqueue → `worker_jobs` + SQS → ESM (kill-switch) → dispatcher Lambda (idempotent on job_id) → Step Functions → RunLambda (short) or `ecs:runTask.sync` Fargate (long/OOM) → worker writes running/succeeded itself → status_updater on Catch sets failed (SFN can't write VPC Aurora) → reaper (5min) reconciles stale. Files: `terraform/v2/foundation/workers.tf`, `scripts/v2/workers/`.

## Build · Test · Lint (copy-paste; do not invent)
```bash
# v2 web (cwd = web/) — scripts: dev / build / start / test (no lint script)
cd web && npm ci && npm run build       # next build (standalone)
cd web && npx vitest run                 # web test suite (vitest)

# agent (Python)
cd agent && python3 -m pytest test_agent.py -q

# Terraform (controller runs apply on shared infra; agents do NOT auto-approve)
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out tfplan   # controller runs `apply tfplan`

# Makefile
make migrate     # ULID migrations + awsops_sql_reader password sync — REQUIRED before agentcore
make deploy      # migrate → buildx arm64 → ECR push → ECS roll → wait stable → smoke /api/health
make agentcore   # arm64 agent image + idempotent AgentCore provisioner (MCP Lambda code ships via terraform apply, NOT this)
make workers     # arm64 worker image push (after apply with workers_enabled=true)
```
No repo-root `package.json` — the only one outside `web/`/`docs-site/` is `scripts/v2/package.json` (`make deps` runs `npm ci --prefix scripts/v2`). `next build` fails on app-level type errors but `*.test.ts(x)` type noise is non-blocking.

## BANNED PATTERNS (enforce in review)
- **AWS security:** no `0.0.0.0/0` ingress; no IAM `Principal:"*"`/wildcard-action without scoped condition; **no secrets in env/code/IaC** (Secrets Manager / SSM).
- **Cognito:** `selfSignUpEnabled`/self-signup must stay closed (`allow_admin_create_user_only = true`); admin-create + `admin_only` account recovery is the ratified model.
- **No AWS-resource mutation or autonomy** — frozen (see posture). Flag any PR that revives it.
- **SG `description` is immutable** — changing it forces a replace that hangs on the attached ALB; ingress changes in-place only.
- **arm64 required** for web/agent/worker images (`buildx --platform linux/arm64`).
- **`HOSTNAME=0.0.0.0` must be a runtime env** (task-def `environment`) for Next standalone — image ENV is insufficient (ECS overwrites → health check UNHEALTHY).
- **Fargate worker Dockerfiles use `CMD`, not exec-form `ENTRYPOINT`** (SFN `containerOverrides.command` appends to ENTRYPOINT → argv doubles).
- **ECS `secrets` valueFrom needs execution-role perms** (not task role) — else `ResourceInitializationError`.
- **No `-auto-approve` on shared infra** — saved `tfplan` only; long applies run by the controller.
- **Flag-gate large new features** (`agentcore_enabled`, `workers_enabled`, `steampipe_enabled`, `hybrid_routing_enabled` — default false → `plan` = No changes, $0).

## Naming / conventions
- Components `export default`. Resources `awsops-v2-*`; gateways `awsops-v2-{key}-gateway`; SSM under `/ops/awsops-v2/...` (`aws...` prefix is SSM-reserved).
- Admin authority = Cognito admin group OR SSM email allowlist (`web/lib/admin.ts`, fail-closed) — NOT v1 `data/config.json` `adminEmails`.
- Edge auth = Cognito + Lambda@Edge **RS256 JWKS** + iss/aud/token_use + OAuth `state` + PKCE public client. Primary login = self-hosted `/login` + `POST /api/auth/login` (unsigned public `InitiateAuth USER_PASSWORD_AUTH`; ADR-002[legacy 042]); Hosted-UI `/_callback` is a dark fallback. Server-side logout = Aurora `session_revocations` (LIVE control, PR #199 — BFF-side check; edge is JWT-only). Ownership converges on the immutable Cognito `sub` (#203); `legacy_email_owner_match` (default **true**) is a migration-window switch, not a feature gate.

## Review checklist
1. **Posture:** no mutation/autonomy enabled (ADR-005); external write must satisfy ADR-007 governance; current truth = BASELINE.md.
2. **Edge/auth — two layers, only one is per-route optional:** *authentication* terminates at the CloudFront Lambda@Edge (RS256/`iss`/`aud`/`token_use`; public-path allowlist lives in `terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl` — currently `/api/health`, `/api/auth/signout`, `/login`, `/api/auth/login`, `/icon.svg`, and any addition is itself flag-worthy). *Authorization, ownership (`sub`) and session revocation are BFF-side only* (ADR-002 §2-4) → RS256 verification intact (no decode-only regression); `verifyUser()` present on every data-returning/billable route outside the three enumerated carve-outs; `session_revocations` check not removed; ownership keyed on `sub`.
3. **Thin-BFF:** heavy work enqueued (domain jobs via their dedicated ownership-checked routes, never generic `/api/jobs`); Aurora via `getPool`; AgentCore ARNs from SSM; admin via `web/lib/admin.ts`.
4. **Terraform:** under `terraform/v2/foundation/`; flag-gated; SG description unchanged; no `0.0.0.0/0` / `Principal:*`; no `-auto-approve`.
5. **Containers:** arm64; `HOSTNAME=0.0.0.0` runtime env; worker `CMD`; health path `/api/health` everywhere.
6. **v2 vs v1:** fetch `/api/*`; state in Aurora; new tables as ULID migration files.
7. **Routing:** golden-routing fixture labels must match `route.ts` RULES order (first-match-wins); `observability` chat key must resolve to a real gateway at runtime.

## Gateway routing & count (ADR-004, amended 2026-06-24)
**9 gateways provisioned / 9 agent routes.** 8 AWS-domain sections (network/container/data/security/cost/monitoring/iac/ops) + **`external-obs`**, a routed section hosting the external-observability connectors Prometheus + ClickHouse (Loki/Tempo/Mimir stay on `monitoring`). Chat key `observability` aliases to `external-obs` in `agent.py` (`_GATEWAY_ALIAS`).
- **Runtime key gotcha:** `_discover_gateways` derives keys via `name.replace("awsops-","").replace("-gateway","")`, so `awsops-v2-external-obs-gateway` yields `v2-external-obs`; `_resolve_gateway_key` tries the canonical key AND the `v2-` variant (coexistence shim until v1 teardown).
- **Single-account self-assume trap:** when the chat target account == host, `cross_account.get_role_arn()` returns `None` (use the exec role) — do not "fix" this back to assuming `AWSopsReadOnlyRole` on the host (it only exists in *target* accounts).

## Known false-positives (do NOT flag)
- **Dark code is intentional:** frozen-but-present slices (`remediation.tf`, mutating substrate) are deliberately retained dark code, not dead code.
- Fetch `/api/...` without `/awsops` prefix is correct in v2.
- Feature flags defaulting false (so `plan` = No changes) is intentional.
- Legacy-numbered ADR citations styled `ADR-0NN[legacy 0XX]` are the documented convention, not typos; bare legacy numbers in `docs/history/` provenance files are expected.
- `/api/db`, `/api/stream`, `/api/incidents/webhook` skipping `verifyUser()` is sanctioned — the three carve-outs ADR-002 §2-4 enumerates (`/api/db` leaks only a table count + db name, `/api/stream` only a tick counter, and the webhook is machine ingress on HMAC-SHA256/SNS alternate auth per ADR-013, never a Cognito session path). **Every other data-returning or billable route must call `verifyUser()`** — the edge is JWT-only and knows nothing of `session_revocations`, so an omission is an immediate revocation bypass. Do flag it.
- Chat classifier calling Bedrock Haiku for routing is intentional (regex-first, golden-set informational band 0.3–0.85, not a gate).
- Flag-gated Steampipe Fargate+Lambda inventory sync (default off) is the only sanctioned Steampipe in v2 — a batch loader into Aurora, not a live-query service. The `aws-data` chat route and the 6 auto-collect collectors' keys stay selectable, but `steampipeAvailable()` (`web/lib/aws-data.ts`) returns `false` unconditionally per ADR-001/010 (live AWS reads go through AgentCore MCP Lambda tools instead), and **none of their own logic ever runs on that `false`** — `web/app/api/chat/route.ts` emits one honest unavailable status frame and resets the routing key to `ops` (not a partial in-route degradation; even collectors like `eks-optimize` that also touch CloudWatch gate their entire `collect()` on Steampipe because cluster discovery itself is Steampipe-only). What happens next is decided by the same routing logic every other request goes through (`resolveAgent`, inactive-section handling, and — gated by `MULTI_ROUTE_SYNTHESIS_ENABLED`, default off — multi-domain fan-out), not hardcoded to a single `ops` answer here: it could resolve to the `ops` gateway alone, the product-help assistant fallback, or a multi-domain fan-out if that flag is on. The SELECT-only guard, 200-row cap and `SQL_GEN_PROMPT` are retained **dark code** — do not flag them as dead, and do not "fix" `steampipeAvailable()` back onto `steampipe_enabled` (that flag toggles only the batch inventory-sync worker; gating on it re-opens the prohibited path).
- Exact Aurora minor `17.9` + `lifecycle{ignore_changes=[engine_version]}` on cluster AND instance is deliberate.
- `CloudFront-VPCOrigins-Service-SG` 443 ingress on the ALB SG is required (VPC-CIDR-only causes 504).
- SFN `.sync` briefly RUNNING after the worker wrote `succeeded` is polling lag; `worker_jobs` is the ledger of truth.
- No `lint` script anywhere in the repo is expected.
- OpenCost: only the *install button* was dropped (mutating); the read-only cost panel/bundle download is live.
