# 변경 이력 / Changelog

AWSops 대시보드 프로젝트의 모든 주요 변경 사항을 기록합니다.
(All notable changes to the AWSops Dashboard project.)

---

## [1.2.0] - 2026-03-11

### 게이트웨이 분리 + 배포 안정성 + 성능 최적화 / Gateway Split + Deployment Reliability + Performance

#### 추가 / Added
- **Network Gateway** (17 tools) — VPC, TGW, VPN, ENI, Firewall, Reachability, Flow Logs
- **Container Gateway** (24 tools) — EKS, ECS, Istio service mesh
- AI 테스트 스크립트 `scripts/test-ai-routes.py` — 대화형 메뉴, 104개 질문, 9 카테고리, 내용 검증
- 테스트 가이드 `docs/AI_TEST_GUIDE.md` — 사용법, 출력 해석, 트러블슈팅
- Custom domain 지원: `awsops.whchoi.net` (CNAME → CloudFront)

#### 변경 / Changed
- **Infra Gateway (41 tools) → Network (17) + Container (24) 분리** — Container 54% 속도 개선 (50s → 23s)
- 7 Gateways → **8 Gateways** (Network / Container / IaC / Data / Security / Monitoring / Cost / Ops)
- 9 Routes → **10 Routes** (Code → Network → Container → IaC → Data → Security → Monitoring → Cost → AWSData → Ops)
- **Bedrock 리전 us-east-1 → ap-northeast-2** (global.* inference profile) — ~20% 지연 감소
- `route.ts`: AgentCore 응답에서 `<tool_call>`/`<tool_response>` 태그 자동 제거
- `benchmark/route.ts`: Steampipe 비밀번호 하드코딩 → 동적 조회 (`steampipe service status`)
- `06a`: `run_or_fail` 헬퍼 + AWS 자격 증명 프리플라이트 체크 + `bedrock-agentcore:*` 권한 추가
- `06b`: 8 Gateways 생성 (network-gateway, container-gateway 추가)
- `06e`: Gateway 키 목록 8개로 업데이트
- `07`: CloudFront 자동 감지 — CDK 스택(AwsopsStack) 우선, ALB origin 폴백
- `04`: EKS access entry ARN `sts` → `iam` 변환 수정
- `install-all.sh`: 8 Gateways, Docker 재빌드 단계 안내, CDK CloudFront 감지

#### 수정 / Fixed
- `06a`: 권한 부족 시 에러 메시지 없이 종료되던 문제 — 단계별 에러 메시지 + 힌트 출력
- `04`: EKS access entry에 `arn:aws:sts::` 형식 사용 → `arn:aws:iam::` 변환 누락으로 kubectl 인증 실패
- `benchmark/route.ts`: 배포 환경별 Steampipe 비밀번호 불일치 (하드코딩 → 동적)
- `k8s.ts`: PVC `capacity`/`access_modes` JSONB 직렬화 에러 → `::text` 캐스팅
- AgentCore `AWSopsAgentCoreRole`에 `bedrock-agentcore:*` 누락 → Gateway 호출 실패
- AgentCore 응답에 `<tool_call>` 태그 노출 → regex 제거
- Cognito custom domain: `SupportedIdentityProviders`에 `COGNITO` 누락 → Hosted UI 에러
- Cognito 콜백 URL: `/awsops` → `/awsops/_callback` 경로 수정

#### 테스트 결과 / Test Results
- **104/104 질문 통과** (0 failed)
- **라우트 분류 93% 정확도** (97/104)
- **내용 검증 99% 통과** (103/104 valid)
- **평균 응답 27초** (min 8.6s / max 71.8s)

---

## [1.1.0] - 2026-03-07

### AgentCore MCP 게이트웨이 아키텍처 / AgentCore MCP Gateway Architecture

단일 게이트웨이에서 7개 역할 기반 게이트웨이 및 125개 MCP 도구로 전면 재설계.
(Complete redesign from single Gateway to 7 role-based Gateways with 125 MCP tools.)

#### 추가 - 게이트웨이 (7개) / Added - Gateways (7)
- **Infra Gateway** (41 tools) — Network, EKS, ECS, Istio
- **IaC Gateway** (12 tools) — CloudFormation, CDK, Terraform
- **Data Gateway** (24 tools) — DynamoDB, RDS MySQL/PostgreSQL, ElastiCache/Valkey, MSK Kafka
- **Security Gateway** (14 tools) — IAM users, roles, groups, policies, simulation
- **Monitoring Gateway** (16 tools) — CloudWatch metrics/alarms/logs, CloudTrail events/Lake
- **Cost Gateway** (9 tools) — Cost Explorer, Pricing, Budgets, Forecasts
- **Ops Gateway** (9 tools) — Steampipe SQL, AWS Knowledge, Core MCP

#### 추가 - Lambda 함수 (19개) / Added - Lambda Functions (19)
- `awsops-network-mcp` — 15 tools: VPC, TGW, VPN, ENI, Network Firewall, Flow Logs
- `awsops-reachability-analyzer` — VPC Reachability Analyzer
- `awsops-flow-monitor` — VPC Flow Log analysis
- `awsops-eks-mcp` — EKS cluster management, CloudWatch, IAM, troubleshooting
- `awsops-ecs-mcp` — ECS cluster/service/task management, troubleshooting
- `awsops-istio-mcp` [VPC] — Istio Service Mesh via Steampipe K8s CRD tables
- `awsops-iac-mcp` — CloudFormation validate/compliance/troubleshoot, CDK docs
- `awsops-terraform-mcp` — AWS/AWSCC provider docs, Registry module analysis
- `awsops-iam-mcp` — IAM users/roles/groups/policies, policy simulation
- `awsops-cloudwatch-mcp` — Metrics, alarms, Log Insights queries
- `awsops-cloudtrail-mcp` — Event lookup, CloudTrail Lake SQL analytics
- `awsops-cost-mcp` — Cost/usage, comparisons, drivers, forecast, pricing, budgets
- `awsops-dynamodb-mcp` — Tables, queries, data modeling, cost estimation
- `awsops-rds-mcp` — RDS/Aurora instances and clusters, SQL via Data API
- `awsops-valkey-mcp` — ElastiCache clusters, replication groups, serverless
- `awsops-msk-mcp` — MSK Kafka clusters, brokers, configurations
- `awsops-aws-knowledge` — AWS documentation search, regional availability
- `awsops-core-mcp` — Prompt understanding, AWS CLI execution, command suggestions
- `awsops-steampipe-query` [VPC] — Real SQL against 580+ Steampipe tables via pg8000

#### 추가 - 동적 라우팅 / Added - Dynamic Routing
- `agent.py`: 게이트웨이 선택을 `payload.gateway` 파라미터로 수행 (Gateway selection via `payload.gateway` parameter)
- `route.ts`: 9단계 우선순위 키워드 기반 라우팅 (9-route priority keyword-based routing)
  - Code → Infra → IaC → Data → Security → Monitoring → Cost → AWS Data → Ops
- 각 게이트웨이 전문가별 역할 시스템 프롬프트 (Role-specific system prompts for each Gateway specialist)

#### 변경 / Changed
- 도구 선택 정확도 향상을 위해 단일 게이트웨이(29 tools)에서 7개 게이트웨이(125 tools)로 분리 (Single Gateway → 7 Gateways for better tool selection accuracy)
- `network-mcp` 1개 도구(693B)에서 15개 도구(17KB)로 재작성 (rewritten from 1 tool to 15 tools)
- `steampipe-query` boto3 키워드 폴백에서 pg8000 통한 실제 SQL로 업그레이드 [VPC] (upgraded from boto3 keyword fallback to real SQL via pg8000)
- 레거시 게이트웨이 삭제 (`awsops-gateway-g0ihtogknw`) (Legacy Gateway deleted)

#### 추가 - 설치 스크립트 / Added - Installation Scripts
- `agent/lambda/create_targets.py` — Python script to create all 19 Gateway Targets
- `agent/lambda/*.py` — All 16 Lambda source files version controlled
- `06b-setup-agentcore-gateway.sh` rewritten for 7 Gateways
- `06c-setup-agentcore-tools.sh` rewritten for 19 Lambda + 19 Targets

---

## [1.0.1] - 2026-03-07

### 배포 및 인프라 / Deployment & Infrastructure

#### 추가 - CDK 인프라 / Added - CDK Infrastructure
- `infra-cdk/lib/awsops-stack.ts` — VPC, EC2, ALB, CloudFront (CDK)
- `00-deploy-infra.sh` rewritten for CDK (was CloudFormation)
- CDK bootstrap for ap-northeast-2 + us-east-1

#### 추가 - 인증 / Added - Authentication
- Cognito User Pool + OAuth2 Authorization Code flow
- Lambda@Edge (Python 3.12, us-east-1) for CloudFront authentication
- `07-setup-cloudfront-auth.sh` — Lambda@Edge → CloudFront `/awsops*` viewer-request

#### 추가 - AgentCore / Added - AgentCore
- AgentCore Runtime (Strands 에이전트, arm64 Docker, ECR) (Strands Agent, arm64 Docker, ECR)
- AgentCore Gateway (MCP 프로토콜) (MCP protocol)
- 코드 인터프리터 (`awsops_code_interpreter`) (Code Interpreter)
- 4개 하위 단계 스크립트: 06a (Runtime), 06b (Gateway), 06c (Tools), 06d (Interpreter) (4 sub-step scripts)

#### 추가 - Claude Code 스캐폴딩 / Added - Claude Code Scaffolding
- `.claude/hooks/check-doc-sync.sh` — Auto-detect missing module docs
- `.claude/skills/sync-docs/SKILL.md` — Full documentation sync skill
- Module CLAUDE.md files: `src/app/`, `src/components/`, `src/lib/`, `src/types/`
- Auto-Sync Rules in root CLAUDE.md
- `docs/architecture.md`, `docs/decisions/.template.md`, `docs/runbooks/.template.md`

#### 추가 - Git 훅 / Added - Git Hooks
- `.git/hooks/commit-msg` — Auto-strip Co-Authored-By lines
- `.claude/hooks/install-git-hooks.sh` — Portable hook installer

#### 수정 - CDK 배포 이슈 / Fixed - CDK Deployment Issues
- CloudFront CachePolicy: TTL=0 + HeaderBehavior rejected → managed `CACHING_DISABLED`
- ALB SG rules limit: CloudFront prefix list 120+ IPs → port range 80-3000
- EC2 UserData: Steampipe install as root (not ec2-user)
- Steampipe listen mode: `local` → `network` for VPC Lambda access

#### 수정 - AgentCore 알려진 이슈 / Fixed - AgentCore Known Issues
- Gateway Target API: `lambdaTargetConfiguration` → `mcp.lambda` structure
- `credentialProviderConfigurations` required (GATEWAY_IAM_ROLE)
- Code Interpreter naming: hyphens → underscores
- Code Interpreter: `networkConfiguration.networkMode` required
- psycopg2 incompatible with Lambda → pg8000 (pure Python)

#### 변경 - 문서 / Changed - Documentation
- `ARCHITECTURE.md` — CDK architecture, 10-step installation flow, IAM roles table
- `CLAUDE.md` — Deployment scripts, AgentCore known issues
- `README.md` — 10-step installation, project structure, known issues

---

## [1.0.0] - 2026-03-07

### 최초 릴리스 / Initial Release

- AWSops 대시보드 21개 페이지 + 5개 API 라우트 (21 pages + 5 API routes)
- Next.js 14 (App Router) + Tailwind CSS 다크 테마 (dark theme)
- Steampipe 내장 PostgreSQL (380+ AWS 테이블, 60+ K8s 테이블) (380+ AWS tables, 60+ K8s tables)
- Recharts 메트릭 시각화 (metrics visualization)
- React Flow 네트워크 토폴로지 (network topology)
- Powerpipe CIS v1.5~v4.0 벤치마크 (CIS benchmarks)
- AI 라우팅: Code Interpreter → AgentCore → Steampipe+Bedrock → Bedrock Direct (AI routing)
- Bedrock Sonnet/Opus 4.6 통합 (Bedrock integration)
