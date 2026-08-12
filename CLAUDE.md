# AWSops v2 — Claude 컨텍스트

> **v2 아키텍처**(Terraform · ECS Fargate · Aurora · AgentCore 에이전트 · 비동기 워커)가 `main`에 live입니다.
> v1.8.0(CDK/EC2/Steampipe, `/awsops` basePath)은 **ADR-016(2026-07-09)에 따라 단계적 폐기 진행 중**입니다 — `docs/runbooks/v1-decommission.md` 참조. **Phase 5(repo 코드 정리, `src/`/`infra-cdk/` 등) 완료(2026-07-12)** — v1 앱 코드는 더 이상 트리에 없음(복원: git tag `v1-pre-code-removal-20260712`). Phase 4(AWS 인프라 완전삭제)는 유예기간 종료 후 별도 진행 — v1 EC2/CloudFront는 아직 존재(stop/disable 상태). v1 규칙(특히 `/awsops` fetch 접두사, Steampipe pg Pool)은 **v2에 적용되지 않습니다.**

## 프로젝트 개요
AWSops는 실시간 AWS/Kubernetes 운영 대시보드입니다. v2는 v1의 단일 EC2 모놀리식을 **Terraform 기반 MSA**로 재구축합니다: 비공개 엣지(CloudFront VPC Origin → 내부 ALB → Fargate), Cognito Lambda@Edge 인증, Aurora 영속 상태, AgentCore 섹션 에이전트(라이브 AWS 조회), OOM-안전 비동기 워커 티어.

## 아키텍처 (v2)
- **IaC**: **Terraform** (CDK 폐기). `terraform/v2/foundation/` 단일 루트, **partial S3 backend**(`backend.hcl`, `awsops-v2-tfstate`, `use_lockfile` — DynamoDB 없음). TF ≥1.15, provider `~>6.0`.
- **엣지**: CloudFront(TLS) → **VPC Origin `https-only:443`** → **내부 ALB HTTPS:443**(리전 ACM) → HTTP → Fargate `awsops-v2-web:3000`. **공개 ALB 없음.** ALB SG는 CloudFront 관리형 SG `CloudFront-VPCOrigins-Service-SG`에서 443 허용(VPC-CIDR-only는 504).
- **인증**: Cognito User Pool + **Lambda@Edge**(`us-east-1`, python3.12, viewer-request). **RS256 JWKS 서명 검증** + iss/aud/token_use + OAuth `state` + **PKCE public client**(시크릿 없음). 도메인 `a-ops-v2-auth-*`('aws'는 Cognito 예약어). **로그인 = 자체 `/login` 폼**(ADR-002[legacy 042]) — BFF `POST /api/auth/login`가 무서명 공개 `InitiateAuth(USER_PASSWORD_AUTH)` 호출 → `awsops_token` 발급(id_token 12h). 미인증 시 엣지가 `/login`으로 redirect; **Hosted UI PKCE 플로우(`/_callback`)는 다크 폴백으로 보존**. signout은 쿠키 삭제 → `/login`(Hosted UI `/logout` 왕복 없음). **공개 경로 allowlist**(`edge-lambda/cognito_edge.py.tftpl`)는 정확 매치 5개(`/api/health`, `/api/auth/signout`, `/login`, `/api/auth/login`, `/icon.svg`) + prefix 1개(`/_next/static/*`) + `/api/incidents/webhook`(ADR-013 머신-인그레스 대체인증 carve-out, HMAC-SHA256/SNS 검증) — 이 목록 밖의 신규 경로 추가는 그 자체로 리뷰 대상.
- **웹**: **Next.js 14 thin-BFF** (`web/`, standalone **arm64**, **루트 경로 — basePath 없음**). 라우트: `/api/health`(공개), `/api/stream`(SSE), `/api/db`(Aurora ping), `/api/jobs`(+`/[id]`, P2 비동기 작업). 무거운 작업은 직접 처리하지 않고 **워커 큐로 enqueue**(범용 `/api/jobs`는 allowlist된 job type만 수락 — `report`/`compliance` 등은 소유권 검사하는 전용 라우트 경유, ADR-009).
- **데이터**: **Aurora Serverless v2** (`awsops-v2-aurora`, **PG 17.9**, 0.5–4 ACU, KMS CMK, RDS-관리 master secret). **ADR-001[legacy 030] 기반 스키마(베이스라인 v9 동결 — 테이블 수는 `data/schema.sql` 참조)** + P2 `worker_jobs`. 앱은 **node-pg**(`web/lib/db.ts`)로 접근. **flag-gated Steampipe 인벤토리 sync(D1, `steampipe_enabled`) 존재** — 라이브 쿼리는 여전히 AgentCore MCP Lambda 도구가 담당.
- **AI (AgentCore)**: Bedrock Sonnet 5 / **Opus 4.8** / Haiku 4.5 + AgentCore Runtime(Strands, `agent/agent.py` 재사용) + **9 섹션 게이트웨이**(8 AWS 도메인 `awsops-v2-{network,container,data,security,cost,monitoring,iac,ops}-gateway` + **external-obs**; external-obs는 외부 관측성 커넥터[Prometheus·ClickHouse]를 호스팅하는 라우팅 섹션 — **ADR-004 개정 2026-06-24: 9 프로비저닝 / 9 라우트**, 챗 키 `observability`는 external-obs로 별칭. Loki/Tempo/Mimir는 monitoring 잔류) + Memory + Code Interpreter. **설계: 9 섹션 에이전트 + 1 인시던트 오케스트레이터**. 함대 배포됨 — 9 게이트웨이 전부 READY MCP 타깃 보유, **챗 섹션 16키 등록**(2026-08-02 container/iac 활성화로 완료; 함대 정의는 `ai.tf` `local.agent_lambdas` — 슬라이스 30개: 21개 `agentcore_enabled` + 9개 `integrations_enabled` 게이트). 챗에는 **web BFF 로컬 라우트**(AgentCore 게이트웨이 경유 아님)도 있음: **aws-data**(LLM 생성 Steampipe SQL, `web/lib/aws-data.ts`) + **auto-collect 콜렉터 6종**(idle-scan · eks-optimize · db-optimize · msk-optimize · trace-analyze · incident, `web/lib/collectors/` 레지스트리) — 이 7개는 **키는 여전히 라우팅 대상으로 선택 가능**하지만, 선택된 순간 자기 고유 로직(SQL 생성/실행, 콜렉터 수집)을 **전혀 실행하지 않는다**: `steampipeAvailable()`(`web/lib/aws-data.ts`)이 무조건 `false`를 반환하기 때문(ADR-001/010이 v2의 라이브 Steampipe 쿼리 경로를 금지 — 라이브 AWS 조회는 AgentCore MCP 도구 담당). 호출자 7개 전부 이 `false`에 fail-open해, 안내 status 프레임 하나만 내보내고 라우팅 키를 `ops`로 리셋한다 — "Steampipe 단계만 스킵되고 나머지는 aws-data/콜렉터 로직으로 이어진다"가 아니라, aws-data/콜렉터 고유 로직 자체가 통째로 Steampipe에 의존하므로 그 순간부터 aws-data/콜렉터 코드는 전혀 실행되지 않는다(`eks-optimize`처럼 CloudWatch도 함께 쓰는 콜렉터조차 클러스터 목록을 Steampipe로만 얻으므로 예외 없음). 그 뒤 요청이 어떻게 처리되는지는 aws-data/콜렉터가 정하는 게 아니라, 다른 모든 요청과 똑같이 그 시점의 라우팅 로직(`resolveAgent`, 인액티브-섹션 처리, `MULTI_ROUTE_SYNTHESIS_ENABLED`[기본 off] 게이트의 멀티도메인 fan-out 여부 포함)이 정한다 — `ops` 게이트웨이 단일 응답이 될 수도, 제품-도움 어시스턴트 폴백이 될 수도, 그 플래그가 켜져 있으면 멀티도메인 fan-out이 될 수도 있다. SELECT-only 가드/200행 캡/`SQL_GEN_PROMPT`는 dark code로 보존. `steampipe_enabled`는 **배치 인벤토리 sync 전용** 플래그이므로 여기에 재게이팅하면 금지된 경로가 재개방된다 → 16키 = 9 게이트웨이 + aws-data + 콜렉터 6. **설정 source of truth = SSM** `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}`.
- **비동기 워커(P2)**: web `POST /api/jobs` → `worker_jobs`(queued) + SQS → **ESM(킬스위치)** → dispatcher Lambda(멱등, job_id 기준) → **Step Functions Standard** `$.runtime` Choice → RunLambda(짧음) **또는** `ecs:runTask.sync` Fargate(긺/OOM) → 워커가 직접 running/succeeded 기록 → Catch 시 status_updater Lambda가 failed(SFN은 VPC Aurora 쓰기 불가) → reaper(EventBridge 5분)가 stale 정합화.
- **EKS 온보딩**: `configure.mjs` 멀티선택 → `eks.tf`가 web task role에 **Access Entry + AmazonEKSAdminViewPolicy**(클러스터 스코프) 부여. kubeconfig 자동등록/조회 UI는 P3.

## 현황 (단계별)
| 단계 | 내용 | 상태 |
|------|------|------|
| P1a | S3 backend + foundation + 비공개 엣지(CloudFront VPC Origin → 내부 ALB → Fargate) | ✅ GREEN |
| P1b | Cognito + Lambda@Edge 인증 | ✅ |
| P1c | Aurora Serverless v2 (ADR-001[legacy 030] 기반 스키마 — 베이스라인 v9 동결, 테이블 수는 `data/schema.sql` 참조) | ✅ |
| P1d | web thin-BFF + dual-tier ECR + `make deploy` + RS256 인증 강화 | ✅ |
| P1e | EKS 온보딩 (Access Entry + AdminView policy) | ✅ |
| P1f | AgentCore 멱등 provisioner (9 GW + Memory + Interpreter + Runtime) | ✅ |
| P2 | 비동기 워커 백본 (SQS+SFN+Lambda/Fargate, `worker_jobs`) | ✅ W9 GREEN |
| **P3** | 에이전트 함대 + 챗 UI + EKS 조회 (read-only). ~~OpenCost 설치 버튼(legacy ADR-029 mutating→ADR-005 FROZEN)~~ → **설치 버튼만 폐기 — read-only 비용 패널/번들 다운로드는 live** | 🟡 부분 진행 (read-only 부분 deployed; mutating 부분 reversed) |
| **P4** | 인시던트/ChatOps 라이프사이클 + DevOps Agent 페더레이션 | 🔜 backlog |

라이브 환경: 계정 `180294183052`, 도메인 `awsops-v2.atomai.click`, mgmt-vpc 재사용(`vpc-06801144309cad7dc`, 10.254.0.0/16).

## 필수 규칙 (v2)

### 경로 / 웹
- **루트 경로(`/`)에서 서빙 — basePath 없음.** v2는 전용 도메인을 쓴다. `/awsops/api/*` 접두사 규칙(v1)은 **적용 안 됨** → fetch는 `/api/*`.
- web은 **thin-BFF**: 무거운/장기/OOM 위험 작업은 직접 실행하지 말고 워커 큐에 넣는다. 단 범용 `POST /api/jobs`는 **allowlist된 job type만**(`noop`류) 수락 — `report`·`compliance` 등 도메인 job은 소유권을 검사하는 전용 라우트(`/api/diagnosis`, `/api/compliance/run`)로만 제출한다(IDOR 방지, PR #195/ADR-009).
- 모든 컴포넌트 `export default`, 프로덕션 빌드(standalone) 기준.

### Terraform 규율
- 변경은 `terraform/v2/foundation/`에서. **공유 인프라에 `-auto-approve` 금지** — saved-tfplan(`apply tfplan`)이 자동 게이트 통과. 긴 apply(CloudFront, SG)는 **컨트롤러가 실행**(서브에이전트 idle-timeout).
- 신규 대형 기능은 **count/flag 게이트**로: `agentcore_enabled`, `workers_enabled`, `steampipe_enabled`(인벤토리 sync), `hybrid_routing_enabled`(ADR-003[legacy 038] 챗 라우팅) — 모두 기본 false → `plan`=No changes, $0. 토글 전 기본은 비활성.
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
- **동시 세션이 브랜치를 자주 전환**한다(docs-site 배포 등). 작업 전 `git branch --show-current` 확인. 미커밋 변경은 외부 reset/checkout에 유실될 수 있으니 **작은 단위로 즉시 커밋**.

## 주요 파일

### Terraform (`terraform/v2/foundation/`)
- `network.tf` — VPC 신규생성 or 기존 재사용(`create_network` 플래그)
- `edge.tf` — CloudFront + VPC Origin + 내부 ALB + ACM
- `auth.tf` + `edge-lambda/cognito_edge.py.tftpl` — Cognito + Lambda@Edge(RS256)
- `data.tf` + `data/schema.sql` — Aurora Serverless v2 + ADR-001[legacy 030] 기반 스키마(베이스라인 v9 동결 — 테이블 수는 `data/schema.sql` 참조)
- `workload.tf` — ECS 클러스터/서비스/태스크(web)
- `ecr.tf` — dual-tier ECR(dev-private + prod-public)
- `ai.tf` — AgentCore ECR + IAM role + agent Lambda 슬라이스 + SSM(21개 `agentcore_enabled` + 9개 `integrations_enabled` 게이트)
- `workers.tf` — SQS + ESM + dispatcher/worker/status_updater/reaper Lambda + Step Functions + Fargate 워커(전부 `workers_enabled` 게이트)
- `eks.tf` — `for_each onboard_eks_clusters` Access Entry + AdminView policy
- `steampipe.tf` — D1 인벤토리 데이터층: warm Steampipe Fargate(FDW) + sync Lambda→Aurora (`steampipe_enabled` 게이트)
- `notify.tf` — 진단 완료 이메일 알림 SNS 토픽 + 구독 IAM (`diagnosis_notify_enabled` 게이트)
- `incidents.tf` — 인시던트 라이프사이클 webhook/상태 (`incident_lifecycle_enabled` 게이트, ADR-006[legacy 032])
- `k8sgpt.tf` — K8sGPT 진단층 Bedrock 예산/리소스 (`k8sgpt_enabled` 게이트, ADR-006[legacy 035])
- `writeback.tf` — RCA 결과 write-back 경로 (`rca_writeback_enabled` 게이트)
- `remediation.tf` — 리메디에이션 substrate (`remediation_enabled`·`integrations_write_enabled` 게이트 — **ADR-005 FROZEN, do-not-enable**)
- `secret-rotation.tf` — Aurora secret 회전 시 web 서비스 자가 재시작 (`secret_rotation_redeploy_enabled` 게이트 — **ADR-015 owner-override 유일 예외**, default-off)
- `variables.tf` / `outputs.tf` / `providers.tf` / `backend.tf`

### 스크립트 (`scripts/v2/`)
- `configure.mjs` — 대화형 TUI(VPC/도메인/버킷/EKS 선택 → `terraform.tfvars` + `backend.hcl`)
- `deploy.mjs` — web: login→buildx arm64 push→ECS force-new-deployment→wait stable→smoke `/api/health`
- `agentcore.mjs` + `agentcore/{catalog.py,provision.py}` — arm64 agent 이미지 빌드/푸시 + 멱등 provisioner(Runtime/9 GW/Target/Memory/Interpreter, SSM 기록)
- `workers.mjs` + `workers/{db,dispatcher,handlers,reaper,status_updater,worker_lambda,fargate_worker}.py + sfn.asl.json` — P2 워커 백본 (진단 `report` job + `schedule_dispatcher.py` + `diagnosis/notify.py` 포함)
- `migrate.mjs` / `migrate-core.mjs` / `backfill-*.mjs` / `upgrade.sh` — ULID 마이그레이션 · v1→v2 Aurora 백필 · Aurora 메이저 업글
- `steampipe/` · `eks/` · `incident/` · `remediation/` — 게이트된 서브시스템 도우미(인벤토리 sync · EKS 접근 · 인시던트 · 리메디에이션[**ADR-005 FROZEN**])

### 웹 (`web/`)
- `app/api/{health,stream,db,jobs}/route.ts`, `app/api/jobs/[id]/route.ts` — thin-BFF 라우트
- `app/security/page.tsx` + `app/api/security/{route,refresh}` — 보안 findings(Public S3·Open SG·Unencrypted EBS·IAM MFA), `inventory_resources`에서 BFF 파생(read-only). `s3_public_access`는 sync_lambda SDK sync로 추가
- `app/compliance/page.tsx` + `app/api/compliance/{run,runs,runs/[id],benchmarks}` — CIS 벤치마크(Powerpipe Fargate 워커 `compliance` job → `compliance_runs`/`compliance_results` 이력). 둘 다 `steampipe_enabled` 게이트
- `app/{network-flow,dns-query,ip-addresses,vpc-endpoints,direct-connect}/` + `lib/{nfm,dns-logs,ip-inventory,vpce,dx}.ts` — 네트워크 메뉴 5종: 라이브 NFM top-contributor 쿼리 + E2E 홉 경로 · Resolver/CoreDNS 쿼리로그 Logs Insights 집계 · ENI 기반 IP 인벤토리(미사용 EIP/available ENI 감지) · VPC 엔드포인트 유휴/정책/Gateway 커버리지 분석 · Direct Connect 다운 감지/피크 사용률/BGP 라우트 가시성
- `app/eks/` — EKS 드릴다운: 클러스터 목록 → `[cluster]` 탭(OpenCost 비용 패널 포함) + nodes/pods/deployments/services/explorer/cost 플릿 페이지
- `lib/aws-data.ts` + `lib/collectors/` — 챗 BFF-로컬 핸들러(AgentCore 미경유): aws-data(LLM Steampipe SQL — 라이브 실행은 hard-disabled, ADR-001/010) + auto-collect 콜렉터 6종 레지스트리 — `app/api/chat/route.ts`가 로컬 분기
- `lib/db.ts` — Aurora node-pg 공유 풀(`getPool`)
- `app/layout.tsx`, `app/page.tsx`, `Dockerfile`(standalone arm64)

### 에이전트 (`agent/`, v1 자산 재사용)
- `agent/agent.py` — Strands Agent(`GATEWAYS_JSON` env로 라우팅, EC2 빌드 불필요)
- `agent/lambda/*.py` — MCP 도구 Lambda 소스(함대 배포됨 — `ai.tf` `local.agent_lambdas`에 21+9 슬라이스 정의)

## 배포 (Makefile)
```
make configure   # 대화형 TUI → terraform.tfvars + backend.hcl (deps 자동 설치)
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation plan -out tfplan   # 컨트롤러가 apply tfplan (공유 인프라)
make deploy      # web: arm64 빌드→ECR push→ECS 롤링→stable 대기→smoke /api/health
make migrate     # DB 마이그레이션 + `awsops_sql_reader` 비밀번호 동기화. **agentcore 전에 필수**
                 # (make agentcore는 migrate를 하지 않음 → 생략하면 execute_sql·inventory-read가
                 #  Data API auth 실패. docs/runbooks/agent-sql-reader.md)
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

## ADR / 결정
**결정의 현행 진실 = [`docs/decisions/BASELINE.md`](docs/decisions/BASELINE.md)** — 북극성(WA 6기둥 목표) + 불변식 + 게이트/동결 register + **18개 통합 ADR**(`docs/decisions/0NN-*.md`) 인덱스. 여기부터 읽는다.
- 옛 ADR 001~046 본문은 **트리에 없음** — git tag `adr-legacy-2026-06-22` 보존, 매핑 `docs/decisions/ADR-MAPPING.md`. **명시 요청 없이는 옛 본문(tag)을 읽지 않는다.**
- **AWS 리소스 변경·자율 = FROZEN (ADR-005, do-not-enable).** 완화는 *문서 정리가 아니라* 새 ADR + 멀티-AI 패널 + 날짜박힌 owner-override가 필요한 별도 제품 결정. 외부 DATA read/write는 거버넌스 하 별개(ADR-007).
  - **첫 예외: ADR-015**(운영 자가치유) — 오준석 owner-override(2026-07-01)로 **딱 하나만** 허용: 자기 web 서비스의 `ecs:UpdateService force-new-deployment`(재시작. 이미지/task def 불변, 코드 배포 아님), Aurora secret 회전 이벤트 한정, IAM 1 ARN, secret-id fail-closed, default-off. ADR-005의 나머지(코드 배포, remediation, mutating tools)는 그대로 FROZEN.
- 새 ADR = 최고번호+1(현재 **018**), single Status, **같은 PR에서 BASELINE 갱신 필수**(anti-drift). 규칙은 `docs/decisions/CLAUDE.md`.


## Implementation References
<!-- AUTO-MANAGED:references — /project-init sync가 이 블록을 관리. 수동 편집은 마커 밖에. -->
계층별 구현 레퍼런스는 `docs/reference/`(인덱스: [README](docs/reference/README.md)) — [01 엣지 네트워크](docs/reference/01-edge-network.md) · [02 인증](docs/reference/02-auth.md) · [03 Aurora 데이터](docs/reference/03-data-aurora.md) · [04 web BFF](docs/reference/04-web-bff.md) · [05 AgentCore](docs/reference/05-agentcore.md) · [06 워커](docs/reference/06-workers.md) · [07 EKS](docs/reference/07-eks.md).
전체 조감도: [docs/architecture.md](docs/architecture.md) (이중언어 + mermaid) · 신규 합류: [docs/onboarding.md](docs/onboarding.md) · API 전수 인덱스(84 라우트): [docs/api-reference.md](docs/api-reference.md) · 운영: [docs/runbooks/](docs/runbooks/).
<!-- /AUTO-MANAGED:references -->
