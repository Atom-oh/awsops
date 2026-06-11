# ADR-030: ECS Fargate Workload + Aurora App State + Dual-Tier ECR

## Status: Accepted (2026-05-27) — mechanism refined by ADR-037 (2026-06-10) / 상태: 채택됨 (2026-05-27) — 메커니즘은 ADR-037이 정제 (2026-06-10)

> **⚠️ v2 reality note (2026-06-10, co-agent ADR-consistency review)** — The *intent* of this ADR holds: **Aurora replaces the v1 `data/*.json` state layer**, and **dual-tier ECR** (dev-private / prod-public) is the OSS distribution model. But the **mechanism described in the body below was not implemented as written** and is superseded by **[ADR-037](037-v2-terraform-foundation.md)**:
> - **IaC = Terraform**, not the "CDK refactor" in Consequences (`infra-cdk/lib/...` is v1-only).
> - **Compute = one thin-BFF web service + a flag-gated async worker tier** (SQS → Step Functions → Lambda/Fargate), NOT the four long-lived containers (`awsops-web`/`awsops-steampipe`/`awsops-alert-poller`/`awsops-jobs`) + Service Connect mesh described here.
> - **No live Steampipe.** Live AWS queries go through **AgentCore MCP Lambda tools**; the only Steampipe in v2 is a **flag-gated warm inventory-sync** batch (`var.steampipe_enabled`, default off), NOT a Service-Connect daemon at `awsops-steampipe.awsops.local:9193`. **The Supersession note at the bottom of this ADR is therefore factually wrong about Steampipe and is corrected by ADR-037.**
> - **Config** (`accounts[]`, admin allowlist, AgentCore) lives in **SSM/Aurora**, not a mounted `data/config.json`. (The "`data/config.json` stays as file" row and the ADR-008 reference are v1-only.)
>
> **⚠️ v2 현행 정정 (2026-06-10)** — 본 ADR의 *의도*(Aurora가 v1 `data/*.json` 상태 계층 대체, 이중 ECR 배포)는 유효하나, **아래 본문의 메커니즘은 기술된 대로 구현되지 않았고 [ADR-037](037-v2-terraform-foundation.md)이 승계**한다: IaC=Terraform(CDK 아님), 컴퓨트=thin-BFF 웹 1 + flag-gated 비동기 워커 티어(4-컨테이너/Service Connect 아님), **라이브 Steampipe 없음**(AgentCore MCP, Steampipe는 flag-gated 인벤토리 sync 배치만), 설정=SSM/Aurora(`data/config.json` 아님). **하단 Supersession note의 Steampipe 표현은 사실오류이며 037이 정정.**

## Context / 컨텍스트

The current AWSops deployment runs on a single EC2 instance (`t4g.2xlarge`, ARM64 Graviton) that simultaneously serves three workloads with conflicting resource profiles: (1) the Next.js production server (CPU-steady, latency-sensitive), (2) the embedded Steampipe PostgreSQL (memory-heavy, FDW connection pool), and (3) the AgentCore Docker image build pipeline (CPU/IO burst, multi-gigabyte image layers). When a Docker build runs — which happens during AgentCore Runtime updates (Step 6a) or AI code-review workflow execution — Next.js latency spikes and Steampipe FDW queries time out. The "single-host build + run" coupling has surfaced as an operational pain point.

현재 AWSops 배포는 단일 EC2 인스턴스(`t4g.2xlarge`, ARM64 Graviton)에서 자원 프로파일이 충돌하는 세 워크로드를 동시에 실행한다: (1) Next.js 프로덕션 서버(CPU·지연 민감), (2) 임베디드 Steampipe PostgreSQL(메모리·FDW 풀), (3) AgentCore Docker 이미지 빌드 파이프라인(CPU/IO 버스트, 다GB 이미지 레이어). Docker 빌드가 실행되면 — AgentCore Runtime 업데이트(Step 6a)나 AI 코드 리뷰 워크플로 실행 시 — Next.js 지연이 튀고 Steampipe FDW 쿼리가 타임아웃된다. "단일 호스트에서 빌드+운영" 결합이 운영상 큰 병목으로 드러났다.

A second concern is **stateful local files**. The dashboard currently persists application state as JSON files in `data/` on the EC2 instance: inventory snapshots (`data/inventory/`), cost snapshots (`data/cost/`), conversation memory (`data/memory/`), AgentCore call statistics (`data/agentcore-stats.json`), alert diagnosis records (`data/alert-diagnosis/`), event-scaling plans (`data/event-scaling/`), and report scheduler state (`data/report-schedule.json`). Containerizing the workload exposes this state to loss on every container replacement — exactly the concern that prompted this ADR.

두 번째 우려는 **상태가 있는 로컬 파일**이다. 대시보드는 현재 EC2 인스턴스의 `data/`에 JSON으로 애플리케이션 상태를 영속화한다: 인벤토리 스냅샷(`data/inventory/`), Cost 스냅샷(`data/cost/`), 대화 메모리(`data/memory/`), AgentCore 호출 통계(`data/agentcore-stats.json`), 알림 진단 기록(`data/alert-diagnosis/`), 이벤트 스케일링 플랜(`data/event-scaling/`), 리포트 스케줄러 상태(`data/report-schedule.json`). 워크로드를 컨테이너화하면 컨테이너가 교체될 때마다 이 상태가 소실된다 — 본 ADR의 출발점이 된 우려와 정확히 일치한다.

A subtle but important nuance: **Steampipe itself is largely stateless.** It is a PostgreSQL with Foreign Data Wrappers that query AWS APIs in real time; query results are held in an in-memory cache, not on disk. The persistence concern therefore does *not* apply to Steampipe's query data — it applies to the application's own JSON state files listed above. Steampipe needs config (`~/.steampipe/config/*.spc`) and credentials to persist across restarts, but those are read-only configuration, not query data. This distinction shapes the decision: Aurora replaces the JSON state layer, not Steampipe.

미묘하지만 중요한 점: **Steampipe 자체는 사실상 stateless이다.** AWS API를 실시간으로 조회하는 FDW(Foreign Data Wrapper) 기반 PostgreSQL이며, 쿼리 결과는 디스크가 아닌 인메모리 캐시에만 보관된다. 따라서 영속성 우려는 Steampipe의 쿼리 데이터에는 *해당되지 않고*, 위에 나열한 애플리케이션 자체의 JSON 상태 파일에 해당된다. Steampipe는 설정(`~/.steampipe/config/*.spc`)과 자격 증명만 재시작 사이에 유지되면 되며, 이는 읽기 전용 구성일 뿐 쿼리 데이터가 아니다. 이 차이가 본 결정의 골격을 만든다: Aurora는 JSON 상태 계층을 대체하며, Steampipe를 대체하지 않는다.

A third driver is **distribution strategy**. AWSops is published as open source on GitHub. Dev/staging images contain non-public dependencies, customer logos, and pre-release AgentCore configurations that must stay private. Production release images, by contrast, are intended for community consumption (`docker pull public.ecr.aws/awsops/...`) and should be world-readable. The dual-tier ECR layout (private for dev, public for prod) makes this explicit at the registry boundary.

세 번째 동인은 **배포 전략**이다. AWSops는 GitHub에서 오픈소스로 공개된다. Dev/Staging 이미지는 비공개 의존성, 고객 로고, 사전 릴리스 AgentCore 구성을 포함하므로 비공개여야 한다. 반면 프로덕션 릴리스 이미지는 커뮤니티 사용(`docker pull public.ecr.aws/awsops/...`)을 위한 것으로 누구나 받을 수 있어야 한다. 이중 ECR 계층(Dev=Private, Prod=Public)이 레지스트리 경계에서 이 분리를 명시한다.

## Options Considered / 고려한 대안

### Option 1: ECS Fargate workload + Aurora Serverless v2 + Dual-Tier ECR — chosen / 채택

Split into four containers running on ECS Fargate behind the existing ALB+CloudFront: `awsops-web` (Next.js), `awsops-steampipe` (Steampipe daemon with mounted config), `awsops-alert-poller` (SQS poller), and `awsops-jobs` (cron jobs: cache-warmer, report-scheduler). Move all `data/*.json` state to Aurora PostgreSQL (Serverless v2, 0.5–4 ACU). Build pipeline runs in CodeBuild (or GitHub Actions), pushing dev images to a private ECR repository and signed prod release images to a public ECR repository. EC2 build host is decommissioned.

기존 ALB+CloudFront 뒤에서 ECS Fargate로 4개 컨테이너를 분리 실행: `awsops-web`(Next.js), `awsops-steampipe`(Steampipe 데몬, 설정 마운트), `awsops-alert-poller`(SQS 폴러), `awsops-jobs`(크론: 캐시 워머·리포트 스케줄러). 모든 `data/*.json` 상태를 Aurora PostgreSQL(Serverless v2, 0.5–4 ACU)로 이전. 빌드 파이프라인은 CodeBuild(또는 GitHub Actions)에서 실행되며 Dev 이미지는 Private ECR, 서명된 Prod 릴리스 이미지는 Public ECR로 푸시. EC2 빌드 호스트는 폐기.

- **Pros / 장점**: Build and runtime decoupled — no more latency spikes during image builds. Aurora gives durable, queryable state with automatic backups and point-in-time recovery. Fargate eliminates node management. Public ECR enables clean OSS distribution. Scales horizontally per service (web pods scale independent of Steampipe).
- **Cons / 단점**: Fargate is ~30–50% more expensive per vCPU-hour than EC2-backed ECS. Aurora Serverless v2 minimum charge applies even at idle (0.5 ACU ≈ \$43/mo). Cross-container service discovery (Service Connect or ALB target groups) adds operational surface. The migration from JSON files to a relational schema requires data backfill scripts and dual-write during cutover.

### Option 2: Keep EC2, move only the build off / EC2 유지 후 빌드만 분리

Retain the current `t4g.2xlarge` for Next.js + Steampipe + local `data/`. Move Docker builds to CodeBuild and push images to a single private ECR. No Aurora migration.

현재 `t4g.2xlarge`는 Next.js + Steampipe + 로컬 `data/`용으로 유지. Docker 빌드만 CodeBuild로 이전, 단일 Private ECR로 푸시. Aurora 이전 없음.

- **Pros / 장점**: Minimal change. Solves the immediate build-vs-runtime contention. Keeps costs flat. No data migration risk.
- **Cons / 단점**: Does not solve state durability — a hung EC2 instance still loses all `data/*.json` content on stop/start (ephemeral instance store) or EBS snapshot lag. Single point of failure remains. No path to horizontal scaling. Does not address the OSS distribution model.

### Option 3: EKS instead of ECS / ECS 대신 EKS

Run all containers on an EKS cluster (consistent with AWSops's K8s focus). Aurora for state, dual ECR for distribution.

모든 컨테이너를 EKS 클러스터에서 실행(AWSops의 K8s 주력과 일관). 상태는 Aurora, 배포는 이중 ECR.

- **Pros / 장점**: Aligns the dashboard's own runtime with the K8s diagnostic surface it provides. Richer scheduling (PDBs, taints, HPA on custom metrics).
- **Cons / 단점**: EKS adds a control-plane cost (~\$73/mo) and requires kubeconfig management, IRSA roles, and add-on lifecycle (CNI, CoreDNS, EBS CSI) for a workload that has only 4 services. The complexity does not pay back at this scale; ECS Fargate covers the requirement with less surface area. Rejected as over-engineering for a 4-service workload.

### Option 4: Aurora for everything (Steampipe too) / 모든 것을 Aurora로

Install the Steampipe FDW extension on Aurora and use Aurora as both the AWS query layer and the app state layer.

Aurora에 Steampipe FDW 확장을 설치하여 AWS 쿼리 계층과 앱 상태 계층을 모두 Aurora로 통합.

- **Pros / 장점**: Single database to operate.
- **Cons / 단점**: Steampipe's FDW extension is not officially supported on Aurora, and Aurora restricts `CREATE EXTENSION` for non-allowlisted extensions. The 380+ AWS table FDWs depend on Steampipe-specific binaries (`steampipe-plugin-aws`) that cannot be loaded into a managed RDS/Aurora instance. Rejected as technically infeasible.

## Decision / 결정

Adopt Option 1: **ECS Fargate workload + Aurora Serverless v2 for app state + Dual-tier ECR (Private dev / Public prod)**. The migration runs in three phases:

옵션 1을 채택한다: **ECS Fargate 워크로드 + 앱 상태용 Aurora Serverless v2 + 이중 ECR(Dev=Private / Prod=Public)**. 세 단계로 이전한다:

| Phase | Scope | Cutover Criterion |
|-------|-------|-------------------|
| Phase 1 | Aurora provisioning + `data/` JSON schema migration + dual-write from existing EC2 (read still from JSON) | 7-day dual-write parity check (zero drift) |
| Phase 2 | ECS Fargate Task Definitions + Service Connect mesh + ALB target migration; web/jobs/alert-poller cut over (Steampipe still on EC2 for one cycle) | Latency p95 ≤ current EC2 baseline; zero failed health checks for 24 h |
| Phase 3 | Steampipe to Fargate (with config mounted from Secrets Manager); EC2 build host decommission; Public ECR prod release pipeline | Steampipe FDW query latency within 20% of EC2 baseline; first signed Public ECR release tagged |

State migration target table layout (Aurora PostgreSQL):

상태 이전 대상 테이블 레이아웃(Aurora PostgreSQL):

| Current JSON source | Aurora table | Notes |
|---------------------|--------------|-------|
| `data/inventory/<account>/*.json` | `inventory_snapshots` | Partitioned by `account_id`, `captured_at` |
| `data/cost/<account>/*.json` | `cost_snapshots` | Partitioned by `account_id`, `period` |
| `data/memory/<user>/*.json` | `agentcore_memory` | Indexed by `user_sub`, `created_at`; 365-day TTL |
| `data/agentcore-stats.json` | `agentcore_stats` | Append-only event log; daily rollup view |
| `data/alert-diagnosis/*.json` | `alert_diagnosis` | JSONB column for raw record + extracted columns for similarity search |
| `data/event-scaling/*.json` | `event_scaling_plans` | Append-only, status column for plan lifecycle |
| `data/report-schedule.json` | `report_schedules` | Singleton per user, KST timezone-aware |
| `data/config.json` | **stays as file** | Bootstrap config, must load before DB connection |

`data/config.json` is intentionally excluded from migration: it bootstraps the database connection itself, so it must remain a file mounted from a ConfigMap or Secret.

`data/config.json`은 의도적으로 이전 대상에서 제외한다: 데이터베이스 연결 자체를 부트스트랩하는 설정이므로 ConfigMap 또는 Secret으로 마운트되는 파일로 남는다.

ECR layout:

ECR 레이아웃:

| Tier | Registry | Repositories | Auth |
|------|----------|--------------|------|
| Dev | Private ECR (`<account>.dkr.ecr.<region>.amazonaws.com`) | `awsops-web-dev`, `awsops-steampipe-dev`, `awsops-jobs-dev`, `awsops-alert-poller-dev` | IAM (Task Execution Role) |
| Prod | Public ECR (`public.ecr.aws/awsops/*`) | `awsops-web`, `awsops-steampipe`, `awsops-jobs`, `awsops-alert-poller` | Anonymous pull; signed pushes only |

Prod images are signed with `cosign` and tagged with the semantic version (`v1.9.0`, `v1.9.0-arm64`). Tag immutability is enforced on the Public ECR side.

Prod 이미지는 `cosign`으로 서명하며 시맨틱 버전(`v1.9.0`, `v1.9.0-arm64`)으로 태깅한다. Public ECR에서 태그 불변성을 강제한다.

ECS launch type: **Fargate** for all four services. Web and jobs run on ARM64 (Graviton) Fargate to match the existing Steampipe binary and the AgentCore Runtime image. ~~Service Connect provides internal DNS (`awsops-steampipe.awsops.local:9193`), removing the need for a separate service-discovery layer.~~ *(2026-06-10 ADR-037 correction: no live Steampipe — inventory sync only; no Service-Connect daemon.)*

ECS launch type: 모든 4개 서비스 **Fargate**. Web과 jobs는 기존 Steampipe 바이너리·AgentCore Runtime 이미지에 맞춰 ARM64(Graviton) Fargate에서 실행. ~~Service Connect가 내부 DNS(`awsops-steampipe.awsops.local:9193`)를 제공하여 별도 서비스 디스커버리 계층이 불필요.~~ *(2026-06-10 ADR-037 정정: 라이브 Steampipe 없음 — 인벤토리 sync만; Service-Connect 데몬 없음.)*

## Consequences / 영향

### Positive / 긍정적

- **Build-runtime decoupling**: AgentCore Docker builds no longer steal CPU from Next.js or Steampipe. Step 6a (`06a-setup-agentcore-runtime.sh`) moves to CodeBuild, removing the EC2 ARM build dependency.
- **Durable state**: Container replacement (deploy, scale, spot-eviction) no longer loses inventory snapshots, conversation memory, or alert history. PITR enables incident forensics.
- **Independent scaling**: A web traffic spike scales `awsops-web` tasks without touching Steampipe's connection pool budget. Steampipe stays at 1 task with vertical scaling.
- **OSS distribution**: Public ECR lets external users `docker pull public.ecr.aws/awsops/awsops-web:v1.9.0` without an AWS account-bound auth flow.
- **Patching surface shrinks**: No more `dnf upgrade` on EC2; image rebuild + redeploy replaces OS patching.

### Negative / 부정적

- **Cost increase**: Fargate per-vCPU-hour is higher than equivalent EC2-backed ECS. Estimated baseline: web (0.5 vCPU × 2 tasks) + steampipe (2 vCPU × 1 task) + jobs (0.25 vCPU × 1 task) + alert-poller (0.25 vCPU × 1 task) = 3 vCPU continuous ≈ \$120–150/mo, versus single `t4g.2xlarge` at \$120/mo. Aurora Serverless v2 minimum (0.5 ACU) adds ~\$43/mo. Net: roughly +\$50–80/mo.
- **Migration complexity**: Three-phase cutover with dual-write requires careful drift detection. Bugs in the dual-write layer could corrupt Aurora rows before Phase 1 completes.
- **Public ECR exposure**: Any prod image leak exposes our build pipeline metadata (build args, SBOM). Mitigated by cosign signing and SBOM scrubbing, but the surface is non-zero.
- **Steampipe restart latency**: A Fargate task restart of `awsops-steampipe` cold-starts the FDW connection pool. First-query latency after restart will degrade until cache warms.
- **CDK refactor required**: `infra-cdk/lib/awsops-stack.ts` currently provisions EC2/ALB. Splitting into `awsops-stack.ts` (VPC/ALB/CloudFront), `awsops-data-stack.ts` (Aurora), `awsops-workload-stack.ts` (ECS cluster, services, task definitions) follows the precedent set by ADR-024 but is a non-trivial CDK rewrite.
- **New runbooks needed**: Aurora failover, Fargate task replacement, Public ECR rollback, and `cosign` key rotation each need a runbook before Phase 3 cutover.

### Post-acceptance deviations / 채택 후 변경 사항

- (none yet — to be filled as phases land)

### Open follow-ups at acceptance / 채택 시점의 미해결 항목

The ADR is accepted to unblock implementation, with the following items tracked as Phase 0 pre-work:

구현 착수를 위해 ADR을 먼저 채택하되, 아래 항목은 Phase 0 사전 작업으로 추적한다:

- **Cost validation**: confirm the +\$50–80/mo estimate against actual workload profile (web concurrency, Steampipe FDW pool size, Aurora ACU floor).
- **Aurora schema review**: finalize column types and indexes for the 7 tables in the migration table before Phase 1 dual-write begins. *(이후 ULID 마이그레이션 체계로 대체 — 순차 정수는 동시 브랜치 충돌로 폐기, `migrations/README.md`)*
- **cosign key custody**: decide between AWS KMS-backed signing (preferred for audit trail) vs. local key file (faster bootstrap). Required before any Public ECR push in Phase 3.
- **Runbooks**: Aurora failover, Fargate task replacement, Public ECR rollback, cosign key rotation — must exist in `docs/runbooks/` before Phase 3 cutover.
- **Cache locality vs ADR-017 (added 2026-06-03, co-agent review)**: this split puts the cache-warmer in `awsops-jobs`, a **separate task from `awsops-web`**. ADR-017's warmer only delivers warm hits because it writes into the **process-local `node-cache`** shared with web requests (`src/lib/steampipe.ts`). Across separate Fargate tasks the warmer would warm a cache no web request ever reads. Phase 1 must resolve this — either **externalize the query cache** to a shared store (e.g. ElastiCache/Redis, or the Aurora layer) **or keep the warmer in-process per `awsops-web` task** and drop it from `awsops-jobs`. Until resolved, treat `awsops-jobs` cache-warming as a no-op for the web tier. / **ADR-017 캐시 지역성 (2026-06-03 co-agent 리뷰 추가)**: 이 분리는 캐시 워머를 `awsops-web`과 **별도 태스크인 `awsops-jobs`**에 둔다. ADR-017 워머는 web 요청과 공유되는 **프로세스-로컬 `node-cache`**에 기록해야만 워밍이 효과가 있다. 별도 Fargate 태스크 간에는 워머가 어떤 web 요청도 읽지 않는 캐시를 데우게 된다. Phase 1에서 해결 필요 — **쿼리 캐시를 공유 저장소(ElastiCache/Redis 또는 Aurora)로 외부화**하거나 **워머를 `awsops-web` 태스크 내 인-프로세스로 유지**하고 `awsops-jobs`에서 제거. 해결 전까지 `awsops-jobs` 캐시 워밍은 web 계층에 무효.
- **PDF Chromium bundling vs ADR-019 (added 2026-06-03, co-agent review)**: ADR-019 generates PDF reports via `puppeteer-core`, which requires a **Chromium binary** to be present (the EC2 host previously supplied one out-of-band). The Fargate `awsops-web` image must explicitly **bundle or provision Chromium** (and its fonts), or server-side PDF export breaks on ephemeral tasks. ADR-019's browser Print-to-PDF path remains as a zero-server-cost fallback. Add Chromium to the `awsops-web` Dockerfile before the web cutover. / **ADR-019 PDF Chromium 번들 (2026-06-03 co-agent 리뷰 추가)**: ADR-019는 `puppeteer-core`로 PDF를 생성하며 **Chromium 바이너리**가 존재해야 한다(기존 EC2 호스트가 대역 외로 공급). Fargate `awsops-web` 이미지가 **Chromium(과 폰트)을 명시적으로 번들/프로비저닝**하지 않으면 ephemeral 태스크에서 서버사이드 PDF가 깨진다. ADR-019의 브라우저 Print-to-PDF 경로는 서버 비용 0 폴백으로 유지. web 커토버 전 `awsops-web` Dockerfile에 Chromium 추가.

### Supersession note / 승계 표기 (2026-06-03)

This ADR establishes the **v2 deployment topology** and therefore supersedes the single-EC2 / local-`data/` assumptions of earlier Accepted ADRs **for v2 deployments**: ADR-001 & ADR-005 (Steampipe on the EC2 host's `localhost:9193` → ~~now a separate `awsops-steampipe` Fargate task reached via Service Connect DNS~~ *(2026-06-10 ADR-037 correction: no live Steampipe — inventory sync only; live queries via AgentCore MCP)*), ADR-024 (EC2/ALB CDK three-stack → ECS/Aurora workload+data stacks; EC2 build host decommissioned), and the `data/*.json` persistence in ADR-006/ADR-007 (cost & inventory snapshots → Aurora). Those ADRs remain Accepted as **v1 history**; their host-coupled assumptions do not apply to v2. / 본 ADR은 **v2 배포 토폴로지**를 확립하므로, **v2 배포에 한해** 이전 Accepted ADR들의 단일-EC2 / 로컬-`data/` 가정을 승계한다: ADR-001·ADR-005(EC2 `localhost:9193` Steampipe → ~~Service Connect DNS로 접근하는 별도 `awsops-steampipe` 태스크~~ *(2026-06-10 ADR-037 정정: 라이브 Steampipe 없음 — 인벤토리 sync만; 라이브 조회는 AgentCore MCP)*), ADR-024(EC2/ALB CDK 3-stack → ECS/Aurora workload+data 스택, EC2 빌드 호스트 폐기), ADR-006/ADR-007의 `data/*.json` 영속화(비용·인벤토리 스냅샷 → Aurora). 해당 ADR들은 **v1 이력**으로 Accepted 유지되며 호스트 결합 가정은 v2에 적용되지 않는다.

## References / 참고 자료

- ADR-001 (Steampipe pg Pool) — confirms Steampipe is queried via pg Pool, not CLI; supports Fargate-based externalization.
- ADR-008 (Multi-Account Support) — `accounts[]` in `data/config.json` must remain file-mounted, not Aurora.
- ADR-018 (AgentCore Memory Isolation / 365-day Retention) — `agentcore_memory` table inherits the per-user isolation and TTL semantics from this ADR.
- ADR-024 (CDK Three-Stack Split) — sets the precedent for splitting CDK stacks by failure domain; this ADR extends that pattern.
- Steampipe FDW architecture: <https://steampipe.io/docs/managing/connections>
- Amazon ECR Public Gallery: <https://gallery.ecr.aws/>
- Aurora Serverless v2 pricing: <https://aws.amazon.com/rds/aurora/serverless/>
