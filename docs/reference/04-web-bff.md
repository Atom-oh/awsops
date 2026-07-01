# 04. Web BFF — v2 Reference

## Purpose / 목적

**EN** — The v2 web tier: a Next.js BFF that started **thin** (P1d: 4 routes — health/stream/db/jobs) and has since grown **per-domain** to back the full dashboard — **~21 top-level `/api/*` route groups, ~20 pages** (security, compliance, cost, inventory, topology, eks, integrations, the customization/Agent-Platform console, chat, diagnosis, etc.). The one principle that survived the growth: any long-running, memory-hungry, or fan-out work is still **enqueued as a job** (`POST /api/jobs`), never executed inline on the request path, so the web container stays fast to roll even as the route surface expands.

**KO** — v2 웹 계층은 Next.js BFF로, P1d 시점엔 **얇은**(health/stream/db/jobs 4라우트) 구조로 시작했으나 이후 **도메인별로 대폭 확장**되어 대시보드 전체를 뒷받침한다 — 현재 **`/api/*` 최상위 라우트 그룹 약 21개, 페이지 약 20개**(security, compliance, cost, inventory, topology, eks, integrations, customization/Agent-Platform 콘솔, chat, diagnosis 등). 확장 이후에도 유지된 원칙 하나: 장시간·고메모리·팬아웃 작업은 여전히 **잡(job)으로 큐잉**(`POST /api/jobs`)하며 요청 경로에서 인라인 실행하지 않아, 라우트가 늘어나도 웹 컨테이너는 가볍고 빠르게 롤아웃 가능하다.

## Current design / 현행 설계

**EN**

- **Framework**: Next.js 14 thin-BFF in `web/`, App Router, `output: 'standalone'`, built for **arm64**.
- **Path**: served at the **root path `/`** — there is **no `basePath`** (v1's `/awsops` prefix is gone in v2).
- **Routes — the original P1d thin-BFF four** (still the enqueue backbone):
  - `/api/health` — **public** liveness; the deploy smoke target and the health-check path for both the container and the ALB target group.
  - `/api/stream` — **SSE** stream (heartbeat ~15s, comfortably under the LB/CloudFront read timeouts).
  - `/api/db` — **Aurora ping** via the shared node-`pg` pool (`getPool` in `web/lib/db.ts`); returns a `public_tables` count or an `unconfigured` (503) response when `AURORA_ENDPOINT` is unset.
  - `/api/jobs` (+ `/api/jobs/[id]`) — **P2 async** job submission/lookup. Heavy/long/OOM-risk work is **enqueued here**, never run inline: the route writes a durable ledger row to Aurora then best-effort enqueues to SQS.
- **Routes — grown far beyond that** (~21 top-level groups, ~63 `route.ts` files total): `accounts`, `actions`, `ai-usage`, `auth` (login/signout), `bedrock-metrics`, `chat` (agent invocation), `compliance`, `cost`, **`customization`** (admin-gated Custom Agent Platform CRUD — Agent/Skill catalog, per-account Agent Space, ADR-031→004), `datasources`, `diagnosis`, `eks`, `graph`, `incidents`, `insights`, `integrations`, `inventory`, `me`, `opencost`, `overview`, `security`. Matching UI pages exist for nearly all of these (`web/app/{accounts,ai-diagnosis,assistant,bedrock,compliance,cost,customization,datasources,eks,integrations,inventory,jobs,login,security,topology}/`).
- **Image distribution — dual-tier ECR**: dev-private `awsops-v2-web` and prod-public `public.ecr.aws/r7z4t3s6/awsops-v2-web`.
- **Deploy loop**: `make deploy` → `scripts/v2/deploy.mjs`: ECR login → `buildx` arm64 build+push → ECS `force-new-deployment` → `aws ecs wait services-stable` → smoke `GET /api/health`.
- **Secret wiring**: the Aurora master secret is injected via the ECS task definition `secrets` `valueFrom` (`AURORA_USER`/`AURORA_PASSWORD`), resolved by the **execution role** at task start.

**KO**

- **프레임워크**: `web/`의 Next.js 14 얇은 BFF, App Router, `output: 'standalone'`, **arm64** 빌드.
- **경로**: **루트 경로 `/`** 에서 서비스 — **`basePath` 없음** (v1의 `/awsops` 접두사는 v2에서 제거).
- **라우트 — 원조 P1d thin-BFF 4개**(여전히 enqueue 백본): `/api/health`(공개 liveness, 배포 스모크 + 컨테이너/타깃그룹 헬스 경로), `/api/stream`(SSE, ~15s 하트비트), `/api/db`(node-`pg` 공유 풀 `getPool`로 Aurora ping), `/api/jobs`(+`/[id]`, P2 비동기 — 무거운 작업은 인라인 실행 없이 여기서 큐잉).
- **라우트 — 이후 대폭 확장**(최상위 그룹 약 21개, `route.ts` 총 63개): `accounts`, `actions`, `ai-usage`, `auth`, `bedrock-metrics`, `chat`, `compliance`, `cost`, **`customization`**(admin-gated Custom Agent Platform CRUD — Agent/Skill 카탈로그, 계정별 Agent Space, 구 ADR-031→현 ADR-004), `datasources`, `diagnosis`, `eks`, `graph`, `incidents`, `insights`, `integrations`, `inventory`, `me`, `opencost`, `overview`, `security`. 대응 UI 페이지도 대부분 존재(`web/app/{accounts,ai-diagnosis,assistant,bedrock,compliance,cost,customization,datasources,eks,integrations,inventory,jobs,login,security,topology}/`).
- **이미지 배포 — 듀얼 티어 ECR**: dev-private `awsops-v2-web`, prod-public `public.ecr.aws/r7z4t3s6/awsops-v2-web`.
- **배포 루프**: `make deploy` → `scripts/v2/deploy.mjs` (login → buildx arm64 push → ECS force-new-deployment → wait stable → `/api/health` 스모크).
- **시크릿 주입**: Aurora 마스터 시크릿을 ECS task def의 `secrets` `valueFrom`(`AURORA_USER`/`AURORA_PASSWORD`)로 주입 — **실행 역할(execution role)** 이 태스크 시작 시 해석.

## Decisions (ADRs) / 결정

- **ADR-001** — v2 foundation: ECS Fargate workload + Aurora split (the v2 workload topology this component runs on). → [`../../decisions/001-v2-foundation.md`](../../decisions/001-v2-foundation.md)
- **ADR-024 (legacy → consolidated into ADR-001)** — CDK three-stack split (v1 precedent; **superseded** by the Terraform-based v2 foundation). → [`../../decisions/001-v2-foundation.md`](../../decisions/001-v2-foundation.md)

## Key files / 핵심 파일

| File | Role |
|------|------|
| `web/app/api/health/route.ts` | Public liveness; smoke + health-check target |
| `web/app/api/stream/route.ts` | SSE stream (heartbeat ~15s) |
| `web/app/api/db/route.ts` | Aurora ping via `getPool` |
| `web/app/api/jobs/route.ts` | P2 async job submit (ledger write + SQS enqueue) |
| `web/app/api/jobs/[id]/route.ts` | P2 async job lookup by id |
| `web/app/customization/page.tsx` + `web/app/api/customization/route.ts` | Custom Agent Platform console (admin-gated) — Agent/Skill CRUD (disabled-by-default), per-account Agent Space, DevOps Agent Workshop Guide |
| `web/app/{security,compliance,cost,inventory,topology,eks,integrations,datasources}/` + matching `web/app/api/*` | The rest of the domain pages — grown well beyond the original 4-route surface |
| `web/lib/db.ts` | Shared node-`pg` Pool (`getPool`) |
| `web/Dockerfile` | Multi-stage standalone arm64 build (sets `HOSTNAME=0.0.0.0`) |
| `terraform/v2/foundation/workload.tf` | ECS cluster/service/task def, ALB, TG, IAM roles, secret injection |
| `terraform/v2/foundation/ecr.tf` | Dual-tier ECR (dev-private repo + prod-public repo) |
| `scripts/v2/deploy.mjs` | `make deploy` loop: build → push → roll → wait → smoke |

## Status / 상태

**P1d ✅ GREEN** (foundation) — Web image live, dual-tier ECR, `make deploy` loop, Aurora secret wired, container + ALB health on `/api/health`. **The route/page surface has since grown well past P1d** (customization/Agent-Platform, chat, diagnosis, incidents, security, compliance, cost, inventory, topology, eks, integrations, datasources, opencost, bedrock-metrics, ai-usage — ~21 top-level API groups, ~20 pages) — "thin BFF, nothing heavy" describes the P1d *foundation*, not the current route count; the enqueue-heavy-work-via-`/api/jobs` *principle* is what actually stayed thin and still holds.

## Learnings & gotchas / 학습·함정

Reuse-critical, in priority order:

1. **`HOSTNAME=0.0.0.0` must be a runtime env in the ECS task def — not just an image ENV.** An image-level `ENV HOSTNAME=0.0.0.0` is **overwritten by ECS** with the container's ENI IP. Next.js standalone then binds **only the ENI IP**, so the `127.0.0.1` container healthcheck fails → circuit-breaker rolls the deploy back. Set `HOSTNAME=0.0.0.0` explicitly in the task definition's container `environment`.
   - **KO** — 이미지 레벨 `ENV HOSTNAME`은 ECS가 컨테이너 ENI IP로 덮어쓴다. standalone이 ENI IP에만 바인딩 → `127.0.0.1` 컨테이너 헬스체크 실패 → 서킷 브레이커 롤백. **task def `environment`에 `HOSTNAME=0.0.0.0`를 명시**해야 한다.

2. **Health path must be `/api/health` in BOTH places** — the container healthcheck command AND the ALB target-group health path. A mismatch fails health checks and circuit-breaker-loops the rollout.

3. **ECS `secrets` `valueFrom` needs perms on the EXECUTION role, not the task role.** The execution role resolves secrets at task start; missing `secretsmanager:GetSecretValue` / `kms:Decrypt` there causes `ResourceInitializationError`.

4. **`web/` was previously a Docusaurus guide site.** It was relocated to `docs-site/` before the v2 web app went in. Always `ls` a directory before declaring it "new" — the original plan hadn't inspected `web/`, which forced an unplanned relocation task.

## Source / 출처

- Plan (to be archived): `docs/superpowers/archive/2026-05-31-awsops-v2-p1d-web-cicd-auth.md` (currently at `docs/superpowers/plans/2026-05-31-awsops-v2-p1d-web-cicd-auth.md`).
- Readiness / cross-AI review: [`docs/reviews/v2-p1d-readiness-architecture-review.md`](../../reviews/v2-p1d-readiness-architecture-review.md).
- Root `CLAUDE.md` — HOSTNAME / arm64 deployment gotchas.
