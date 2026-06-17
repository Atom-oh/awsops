# AWSops v2 — Claude 컨텍스트

> **브랜치 `feat/v2-architecture-design`.** 이 문서는 **v2 아키텍처**(Terraform · ECS Fargate · Aurora · AgentCore 에이전트 · 비동기 워커)를 기술합니다.
> v1.8.0(`src/`, CDK/EC2/Steampipe, `/awsops` basePath)은 **레거시 프로덕션 앱으로 그대로 유지**되며 v2와 병렬 존재합니다. v1 규칙(특히 `/awsops` fetch 접두사, Steampipe pg Pool)은 **v2에 적용되지 않습니다.** v1 세부는 `src/**/CLAUDE.md` 참조.

## 프로젝트 개요
AWSops는 실시간 AWS/Kubernetes 운영 대시보드입니다. v2는 v1의 단일 EC2 모놀리식을 **Terraform 기반 MSA**로 재구축합니다: 비공개 엣지(CloudFront VPC Origin → 내부 ALB → Fargate), Cognito Lambda@Edge 인증, Aurora 영속 상태, AgentCore 섹션 에이전트(라이브 AWS 조회), OOM-안전 비동기 워커 티어.

## 아키텍처 (v2)
- **IaC**: **Terraform** (CDK 폐기). `terraform/v2/foundation/` 단일 루트, **partial S3 backend**(`backend.hcl`, `awsops-v2-tfstate`, `use_lockfile` — DynamoDB 없음). TF ≥1.15, provider `~>6.0`.
- **엣지**: CloudFront(TLS) → **VPC Origin `https-only:443`** → **내부 ALB HTTPS:443**(리전 ACM) → HTTP → Fargate `awsops-v2-web:3000`. **공개 ALB 없음.** ALB SG는 CloudFront 관리형 SG `CloudFront-VPCOrigins-Service-SG`에서 443 허용(VPC-CIDR-only는 504).
- **인증**: Cognito User Pool + **Lambda@Edge**(`us-east-1`, python3.12, viewer-request). **RS256 JWKS 서명 검증** + iss/aud/token_use + OAuth `state` + **PKCE public client**(시크릿 없음). 도메인 `a-ops-v2-auth-*`('aws'는 Cognito 예약어). **로그인 = 자체 `/login` 폼**(ADR-042) — BFF `POST /api/auth/login`가 무서명 공개 `InitiateAuth(USER_PASSWORD_AUTH)` 호출 → `awsops_token` 발급(id_token 12h). 미인증 시 엣지가 `/login`으로 redirect; **Hosted UI PKCE 플로우(`/_callback`)는 다크 폴백으로 보존**. signout은 쿠키 삭제 → `/login`(Hosted UI `/logout` 왕복 없음).
- **웹**: **Next.js 14 thin-BFF** (`web/`, standalone **arm64**, **루트 경로 — basePath 없음**). 라우트: `/api/health`(공개), `/api/stream`(SSE), `/api/db`(Aurora ping), `/api/jobs`(+`/[id]`, P2 비동기 작업). 무거운 작업은 직접 처리하지 않고 **워커 큐로 enqueue**.
- **데이터**: **Aurora Serverless v2** (`awsops-v2-aurora`, **PG 17.9**, 0.5–4 ACU, KMS CMK, RDS-관리 master secret). **ADR-030 기반 스키마(베이스라인 v9 동결 — 테이블 수는 `data/schema.sql` 참조)** + P2 `worker_jobs`. 앱은 **node-pg**(`web/lib/db.ts`)로 접근. **flag-gated Steampipe 인벤토리 sync(D1, `steampipe_enabled`) 존재** — 라이브 쿼리는 여전히 AgentCore MCP Lambda 도구가 담당.
- **AI (AgentCore)**: Bedrock Sonnet 4.6 / **Opus 4.8** / Haiku 4.5 + AgentCore Runtime(Strands, `agent/agent.py` 재사용) + **8 섹션 게이트웨이**(`awsops-v2-{network,container,data,security,cost,monitoring,iac,ops}-gateway`; 외부 관측성은 **Integrations 축**[ADR-039]이지 9th 게이트웨이가 아님 — ADR-004 게이트웨이 수 **8** 유지) + Memory + Code Interpreter. **설계: 8 섹션 에이전트 + 1 인시던트 오케스트레이터**(v1의 8 Gateway 대체). 현재 read-only 슬라이스 2개 배포(iam-mcp 14도구→security, flow-monitor 1→network); 전체 함대는 P3. **설정 source of truth = SSM** `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}`.
- **비동기 워커(P2)**: web `POST /api/jobs` → `worker_jobs`(queued) + SQS → **ESM(킬스위치)** → dispatcher Lambda(멱등, job_id 기준) → **Step Functions Standard** `$.runtime` Choice → RunLambda(짧음) **또는** `ecs:runTask.sync` Fargate(긺/OOM) → 워커가 직접 running/succeeded 기록 → Catch 시 status_updater Lambda가 failed(SFN은 VPC Aurora 쓰기 불가) → reaper(EventBridge 5분)가 stale 정합화.
- **EKS 온보딩**: `configure.mjs` 멀티선택 → `eks.tf`가 web task role에 **Access Entry + AmazonEKSViewPolicy**(클러스터 스코프) 부여. kubeconfig 자동등록/조회 UI는 P3.

## 현황 (단계별)
| 단계 | 내용 | 상태 |
|------|------|------|
| P1a | S3 backend + foundation + 비공개 엣지(CloudFront VPC Origin → 내부 ALB → Fargate) | ✅ GREEN |
| P1b | Cognito + Lambda@Edge 인증 | ✅ |
| P1c | Aurora Serverless v2 (ADR-030 기반 스키마 — 베이스라인 v9 동결, 테이블 수는 `data/schema.sql` 참조) | ✅ |
| P1d | web thin-BFF + dual-tier ECR + `make deploy` + RS256 인증 강화 | ✅ |
| P1e | EKS 온보딩 (Access Entry + View policy) | ✅ |
| P1f | AgentCore 멱등 provisioner (9 GW + Memory + Interpreter + Runtime) | ✅ |
| P2 | 비동기 워커 백본 (SQS+SFN+Lambda/Fargate, `worker_jobs`) | ✅ W9 GREEN |
| **P3** | 에이전트 함대 + 챗 UI + EKS 조회 (read-only). ~~OpenCost 설치 버튼(ADR-029 mutating)~~ → **029 번복으로 폐기** | 🟡 부분 진행 (read-only 부분 deployed; mutating 부분 reversed) |
| **P4** | 인시던트/ChatOps 라이프사이클 + DevOps Agent 페더레이션 | 🔜 backlog |

라이브 환경: 계정 `180294183052`, 도메인 `awsops-v2.atomai.click`, mgmt-vpc 재사용(`vpc-06801144309cad7dc`, 10.254.0.0/16).

## 필수 규칙 (v2)

### 경로 / 웹
- **루트 경로(`/`)에서 서빙 — basePath 없음.** v2는 전용 도메인을 쓴다. `/awsops/api/*` 접두사 규칙(v1)은 **적용 안 됨** → fetch는 `/api/*`.
- web은 **thin-BFF**: 무거운/장기/OOM 위험 작업은 직접 실행하지 말고 `POST /api/jobs`로 워커 큐에 넣는다.
- 모든 컴포넌트 `export default`, 프로덕션 빌드(standalone) 기준.

### Terraform 규율
- 변경은 `terraform/v2/foundation/`에서. **공유 인프라에 `-auto-approve` 금지** — saved-tfplan(`apply tfplan`)이 자동 게이트 통과. 긴 apply(CloudFront, SG)는 **컨트롤러가 실행**(서브에이전트 idle-timeout).
- 신규 대형 기능은 **count/flag 게이트**로: `agentcore_enabled`, `workers_enabled`, `steampipe_enabled`(인벤토리 sync), `hybrid_routing_enabled`(ADR-038 챗 라우팅) — 모두 기본 false → `plan`=No changes, $0. 토글 전 기본은 비활성.
- **SG `description`은 불변** — 변경 시 SG replace가 ALB 의존성으로 hang. ingress 변경은 in-place로, description은 그대로.
- **arm64 필수** (web/agent/worker 이미지 모두 `buildx --platform linux/arm64`).

### 데이터 / 설정
- 앱 상태는 **Aurora**(node-pg). `data/*.json`(v1 패턴) 아님. 스키마는 `terraform/v2/foundation/data/schema.sql` + `schema_migrations`.
- ECS `secrets` valueFrom(Aurora secret)는 **실행 역할(execution role)** 권한 필요(task role 아님) — 아니면 `ResourceInitializationError`.
- AgentCore 설정은 **SSM이 source of truth**(provision.py가 기록 → web BFF 런타임 read). valueFrom 미사용(레이스 회피).

### 컨테이너 / 배포
- **Next.js standalone을 컨테이너로 배포 시 `HOSTNAME=0.0.0.0`을 런타임 env로 명시**(task def `environment`) — 이미지 ENV로는 부족(ECS가 HOSTNAME을 ENI IP로 덮어써 0.0.0.0/loopback 미바인딩 → healthCheck UNHEALTHY).
- **Fargate 워커 Dockerfile은 `CMD`(ENTRYPOINT 금지)** — SFN `containerOverrides.command`는 CMD를 대체하지만 exec-form ENTRYPOINT엔 append되어 argv 중복 → argparse 실패.
- 컨테이너+TG health 경로는 앱(`/api/health`)과 일치해야 함(불일치 시 circuit breaker 루프).

### 운영 주의
- **동시 세션이 브랜치를 자주 전환**한다(docs-site 배포 등). 작업 전 `git branch --show-current`=`feat/v2-architecture-design` 확인. 미커밋 변경은 외부 reset/checkout에 유실될 수 있으니 **작은 단위로 즉시 커밋**.

## 주요 파일

### Terraform (`terraform/v2/foundation/`)
- `network.tf` — VPC 신규생성 or 기존 재사용(`create_network` 플래그)
- `edge.tf` — CloudFront + VPC Origin + 내부 ALB + ACM
- `auth.tf` + `edge-lambda/cognito_edge.py.tftpl` — Cognito + Lambda@Edge(RS256)
- `data.tf` + `data/schema.sql` — Aurora Serverless v2 + ADR-030 기반 스키마(베이스라인 v9 동결 — 테이블 수는 `data/schema.sql` 참조)
- `workload.tf` — ECS 클러스터/서비스/태스크(web)
- `ecr.tf` — dual-tier ECR(dev-private + prod-public)
- `ai.tf` — AgentCore ECR + IAM role + agent Lambda 슬라이스 + SSM(전부 `agentcore_enabled` 게이트)
- `workers.tf` — SQS + ESM + dispatcher/worker/status_updater/reaper Lambda + Step Functions + Fargate 워커(전부 `workers_enabled` 게이트)
- `eks.tf` — `for_each onboard_eks_clusters` Access Entry + View policy
- `variables.tf` / `outputs.tf` / `providers.tf` / `backend.tf`

### 스크립트 (`scripts/v2/`)
- `configure.mjs` — 대화형 TUI(VPC/도메인/버킷/EKS 선택 → `terraform.tfvars` + `backend.hcl`)
- `deploy.mjs` — web: login→buildx arm64 push→ECS force-new-deployment→wait stable→smoke `/api/health`
- `agentcore.mjs` + `agentcore/{catalog.py,provision.py}` — arm64 agent 이미지 빌드/푸시 + 멱등 provisioner(Runtime/9 GW/Target/Memory/Interpreter, SSM 기록)
- `workers.mjs` + `workers/{db,dispatcher,handlers,reaper,status_updater,worker_lambda,fargate_worker}.py + sfn.asl.json` — P2 워커 백본

### 웹 (`web/`)
- `app/api/{health,stream,db,jobs}/route.ts`, `app/api/jobs/[id]/route.ts` — thin-BFF 라우트
- `app/security/page.tsx` + `app/api/security/{route,refresh}` — 보안 findings(Public S3·Open SG·Unencrypted EBS·IAM MFA), `inventory_resources`에서 BFF 파생(read-only). `s3_public_access`는 sync_lambda SDK sync로 추가
- `app/compliance/page.tsx` + `app/api/compliance/{run,runs,runs/[id],benchmarks}` — CIS 벤치마크(Powerpipe Fargate 워커 `compliance` job → `compliance_runs`/`compliance_results` 이력). 둘 다 `steampipe_enabled` 게이트
- `lib/db.ts` — Aurora node-pg 공유 풀(`getPool`)
- `app/layout.tsx`, `app/page.tsx`, `Dockerfile`(standalone arm64)

### 에이전트 (`agent/`, v1 자산 재사용)
- `agent/agent.py` — Strands Agent(`GATEWAYS_JSON` env로 라우팅, EC2 빌드 불필요)
- `agent/lambda/*.py` — MCP 도구 Lambda 소스(v2는 P1f에서 iam-mcp/flow-monitor 슬라이스 사용; 전체 함대는 P3)

## 배포 (Makefile)
```
make configure   # 대화형 TUI → terraform.tfvars + backend.hcl (deps 자동 설치)
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation plan -out tfplan   # 컨트롤러가 apply tfplan (공유 인프라)
make deploy      # web: arm64 빌드→ECR push→ECS 롤링→stable 대기→smoke /api/health
make agentcore   # arm64 agent 이미지 + 멱등 AgentCore provisioner (--smoke로 호출 검증). apply 후 실행
make workers     # arm64 worker 이미지 push (workers_enabled=true로 apply 후)
```

## v2 ↔ v1 핵심 차이
| 항목 | v1 (`src/`) | v2 (`web/` + `terraform/v2/`) |
|------|-------------|-------------------------------|
| IaC | CDK | Terraform (partial S3 backend) |
| 컴퓨트 | 단일 EC2 t4g.2xlarge | ECS Fargate (web/worker 분리) |
| 데이터 | Steampipe 임베디드 PG + `data/*.json` | Aurora Serverless v2 PG17 (+ AgentCore 라이브 조회) |
| 경로 | `/awsops` basePath | 루트 `/` (basePath 없음) |
| 엣지 | CloudFront → 공개 ALB → EC2 | CloudFront VPC Origin → 내부 ALB → Fargate |
| AI 구성 | 8 Gateway, 11-route 라우터 | 9 섹션 GW + 1 인시던트 오케스트레이터(설계) |
| 장기 작업 | 인-프로세스 | SQS+SFN+Lambda/Fargate 비동기 워커 |
| 인증 검증 | exp-only(엣지) | RS256 JWKS + PKCE |

## 알려진 이슈 / 학습 (재사용 핵심)
- **엣지 504→200**: CF→ALB는 TLS end-to-end(VPC Origin `https-only` + origin domain=public FQDN으로 SNI 매칭), ALB는 HTTPS:443 + 리전 ACM, ALB SG는 `CloudFront-VPCOrigins-Service-SG` 443 허용. VPC Origin protocol은 in-place 변경 불가 → `create_before_destroy` + `-replace`.
- **Aurora 메이저 업그레이드(15→17.9)**: `variables.tf`에 정확 minor(`17.9`) + `allow_major_version_upgrade`+`apply_immediately`로 먼저 apply(업글) → **그 다음** cluster·instance 둘 다 `lifecycle{ignore_changes=[engine_version]}` 추가(향후 마이너 자동업글 흡수). "17"만 핀하면 `aws_rds_cluster`에서 오작동.
- **SG description 불변**(위 Terraform 규율) / **ECS secrets는 execution-role** / **HOSTNAME=0.0.0.0 런타임 env** / **Fargate 워커 CMD(ENTRYPOINT 금지)**.
- **AgentCore**: Gateway Target은 boto3(`mcp.lambda`+`credentialProviderConfigurations`); 갓 만든 GW가 READY 전이면 첫 target 생성이 ValidationException → 재실행으로 해소(provisioner 멱등 재실행 가능). Code Interpreter/Memory 이름은 언더스코어만, Memory `eventExpiryDuration`≤365.
- **SSM 예약어**: `/aws...` 경로는 'aws' prefix라 거부 → `/ops/${project}/...` 사용.
- **에이전트 cross-account self-assume 함정**: v2는 단일계정인데 챗에서 호스트 계정(`180294183052`)을 고르면 `agent.py`가 `target_account_id=<host>`를 강제 → 도구가 `arn:...:role/AWSopsReadOnlyRole`(v1 *타깃 계정* 전용, 호스트엔 부재)을 self-assume → AccessDenied(에이전트가 "cross-account 차단"으로 **오진**). 수정: `cross_account.get_role_arn()`이 대상=호스트면 `None` 반환(exec 역할 직접 사용) + `agent.py effective_account_id()`가 호스트를 `__all__`처럼 blank(defense-in-depth). 호스트 판별 = `AWSOPS_HOST_ACCOUNT_ID` env → STS `GetCallerIdentity` 폴백(캐시). 진짜 *다른* 계정 assume 경로는 그대로. v1 무영향(별개 함수 `awsops-*-mcp` py3.12 vs v2 `awsops-v2-agent-*` py3.11).

## ADR
`docs/decisions/ADR-*.md` (001–044). v2 관련: **038**(하이브리드 에이전트 라우팅 — 정규식 fast-path + Haiku 분류기 + v2 프롬프트 캐싱; **활성화 LIVE 2026-06-10**, 게이트 hybrid 96.9%/+27.7pp PASSED; Gateway 시맨틱은 P4 연기; 033 확장·031 우선순위 통합); **037**(v2 파운데이션 — Terraform + thin-BFF + 비동기 워커; **024 전면 승계 + 030 메커니즘 정제**; Steampipe=라이브 없음·flag-gated 인벤토리 sync 확정; Accepted 2026-06-10); **030**(ECS Fargate + Aurora — Aurora·이중 ECR 의도 유효, 4-컨테이너/Service Connect/CDK 메커니즘은 037이 승계); **029·031·032·033·034·035·036** v2 ADR **전부 멀티AI 합의로 Accepted (2026-06-09)** (029는 통제 사양으로 재구성 — 메커니즘은 036 하이브리드 위임·6대 통제 유지). **009는 032로 대체됨**(상관분석 엔진은 032 Triage로 보존). **024는 037로 v2 승계**(v1 이력 유지). **admin 모델: v2는 SSM+Cognito group**(`web/lib/admin.ts`, ADR-023 v2 노트). **⛔ 고위험 ADR 번복 (2026-06-11, 3-AI 합의 — `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`): 029+036(변경 substrate)·031 Phase 3(BYO-MCP)·Phase 4(mutating 도구) = REVERSED(do-not-enable, flag-OFF 동결, dark 코드 보존); 032·035 = DOWNGRADED(자율 mitigation·H3a 폐기, read-only Triage/RCA·K8s 진단만 유지); 034 유지(KEPT — flag-OFF; 현재 frozen 029/036 substrate role 재사용 탓 활성화 전 자족 role 분리 선행 필요, ADR-034 배너 참조). → AWSops는 read-only ops 대시보드+AI 진단; **AWS-리소스 변경·자율은 영구 동결(do-not-enable)**.** **후속 039–043 (2026-06-13~15): 멀티에이전트 플랫폼(039)·거버넌스된 외부 knowledge/comms write(040)·keystone 재정의(041)·인앱 로그인(042)·Neptune 그래프 옵션(043). **ADR-041이 'read-only'를 재정의**: read-only 제약 = **AWS-리소스 변경+자율**(SSM/infra/autonomous = 영구 동결 유지), **외부 DATA read+write는 아님** → 외부 관측성 read·외부 기록/티켓/메시지 write는 거버넌스(SSRF·Secrets·DLP/redaction·큐레이션·human-gate·flag-OFF) 하 허용(BYO-MCP는 큐레이션 커넥터만, 임의 형태 제외). ⚠️ **ADR-041은 owner 단독 re-scope** — 멀티-AI 패널 검증 결과 **PARTIAL**(2026-06-16): 외부-write 결과는 ADR-040 패널 비준으로 정당하나, "reversal은 애초에 external-endpoint 대상 아님"이라는 사후 재서술은 2026-06-11 합의문(external-endpoint/egress/SSRF를 명시 scope-creep으로 적시)과 충돌 → ADR-041에 'clarification'이 아닌 **owner-override**로 명기(addendum 반영).** **Proposed 잔여 없음.** 신규 ADR 번호 = 최고번호+1(현재 044). ADR 인덱스/정정 노트는 `docs/decisions/CLAUDE.md`.

---

# AWSops v2 — Claude Context (English)

> **Branch `feat/v2-architecture-design`.** This document describes the **v2 architecture** (Terraform · ECS Fargate · Aurora · AgentCore agents · async workers).
> v1.8.0 (`src/`, CDK/EC2/Steampipe, `/awsops` basePath) **remains the untouched legacy production app**, in parallel with v2. v1 rules (notably the `/awsops` fetch prefix and Steampipe pg Pool) **do NOT apply to v2**. For v1 detail see `src/**/CLAUDE.md`.

## Overview
AWSops is a real-time AWS/Kubernetes operations dashboard. v2 rebuilds the v1 single-EC2 monolith as a **Terraform-based MSA**: private edge (CloudFront VPC Origin → internal ALB → Fargate), Cognito Lambda@Edge auth, Aurora durable state, AgentCore section agents (live AWS query), and an OOM-safe async worker tier.

## Architecture (v2)
- **IaC**: **Terraform** (CDK dropped). Single `terraform/v2/foundation/` root; **partial S3 backend** (`backend.hcl`, `awsops-v2-tfstate`, `use_lockfile` — no DynamoDB). TF ≥1.15, provider `~>6.0`.
- **Edge**: CloudFront(TLS) → **VPC Origin `https-only:443`** → **internal ALB HTTPS:443** (regional ACM) → HTTP → Fargate `awsops-v2-web:3000`. **No public ALB.** ALB SG allows 443 from the CloudFront managed SG `CloudFront-VPCOrigins-Service-SG` (VPC-CIDR-only → 504).
- **Auth**: Cognito User Pool + **Lambda@Edge** (`us-east-1`, python3.12, viewer-request). **RS256 JWKS signature verification** + iss/aud/token_use + OAuth `state` + **PKCE public client** (no secret). Domain `a-ops-v2-auth-*` ('aws' is a Cognito reserved word). **Login = self-hosted `/login` form** (ADR-042) — the BFF `POST /api/auth/login` calls the unsigned public `InitiateAuth(USER_PASSWORD_AUTH)` → mints `awsops_token` (id_token 12h). Unauthenticated requests are redirected to `/login` by the edge; the **Hosted UI PKCE flow (`/_callback`) is retained as a dark fallback**. Signout clears the cookie → `/login` (no Hosted UI `/logout` round-trip).
- **Web**: **Next.js 14 thin-BFF** (`web/`, standalone **arm64**, **root path — no basePath**). Routes: `/api/health` (public), `/api/stream` (SSE), `/api/db` (Aurora ping), `/api/jobs` (+`/[id]`, P2 async jobs). Heavy work is **enqueued** to the worker queue, not run inline.
- **Data**: **Aurora Serverless v2** (`awsops-v2-aurora`, **PG 17.9**, 0.5–4 ACU, KMS CMK, RDS-managed master secret). **ADR-030-based schema (baseline v9 frozen — table count per `data/schema.sql`)** + P2 `worker_jobs`. App uses **node-pg** (`web/lib/db.ts`). **A flag-gated Steampipe inventory sync (D1, `steampipe_enabled`) exists** — live queries still go through AgentCore MCP Lambda tools.
- **AI (AgentCore)**: Bedrock Sonnet 4.6 / **Opus 4.8** / Haiku 4.5 + AgentCore Runtime (Strands, reuses `agent/agent.py`) + **8 section gateways** (`awsops-v2-{network,container,data,security,cost,monitoring,iac,ops}-gateway`; external observability is the **Integrations axis** [ADR-039], not a 9th gateway — ADR-004 keeps the gateway count at **8**) + Memory + Code Interpreter. **Design: 8 section agents + 1 incident orchestrator** (replaces v1's 8 Gateways). Currently 2 read-only slices deployed (iam-mcp 14 tools→security, flow-monitor 1→network); full fleet is P3. **Config source of truth = SSM** `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}`.
- **Async workers (P2)**: web `POST /api/jobs` → `worker_jobs` (queued) + SQS → **ESM (kill-switch)** → dispatcher Lambda (idempotent on job_id) → **Step Functions Standard** Choice on `$.runtime` → RunLambda (short) **or** `ecs:runTask.sync` Fargate (long/OOM) → worker writes running/succeeded itself → on Catch, status_updater Lambda sets failed (SFN can't write VPC Aurora) → reaper (EventBridge 5min) reconciles stale.
- **EKS onboarding**: `configure.mjs` multi-select → `eks.tf` grants the web task role an **Access Entry + AmazonEKSViewPolicy** (cluster-scoped). kubeconfig auto-registration / query UI is P3.

## Status (by phase)
| Phase | Scope | State |
|-------|-------|-------|
| P1a | S3 backend + foundation + private edge | ✅ GREEN |
| P1b | Cognito + Lambda@Edge auth | ✅ |
| P1c | Aurora Serverless v2 (ADR-030-based schema — baseline v9 frozen, table count per `data/schema.sql`) | ✅ |
| P1d | web thin-BFF + dual-tier ECR + `make deploy` + RS256 hardening | ✅ |
| P1e | EKS onboarding (Access Entry + View policy) | ✅ |
| P1f | AgentCore idempotent provisioner (9 GW + Memory + Interpreter + Runtime) | ✅ |
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
- **Concurrent sessions switch branches often** (docs-site deploys, etc.). Verify `git branch --show-current` = `feat/v2-architecture-design` before working. Uncommitted changes can be lost to an external reset/checkout — **commit in small units immediately**.

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
