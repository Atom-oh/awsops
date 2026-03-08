# Changelog / 변경 이력

All notable changes to the AWSops Dashboard project.
(AWSops 대시보드 프로젝트의 모든 주요 변경 사항을 기록합니다.)

---

## [1.1.0] - 2026-03-07

### AgentCore MCP Gateway Architecture / AgentCore MCP 게이트웨이 아키텍처

Complete redesign from single Gateway to 7 role-based Gateways with 125 MCP tools.
(단일 게이트웨이에서 7개 역할 기반 게이트웨이 및 125개 MCP 도구로 전면 재설계)

#### Added - Gateways (7) / 추가 - 게이트웨이 (7개)
- **Infra Gateway** (41 tools) — Network, EKS, ECS, Istio
- **IaC Gateway** (12 tools) — CloudFormation, CDK, Terraform
- **Data Gateway** (24 tools) — DynamoDB, RDS MySQL/PostgreSQL, ElastiCache/Valkey, MSK Kafka
- **Security Gateway** (14 tools) — IAM users, roles, groups, policies, simulation
- **Monitoring Gateway** (16 tools) — CloudWatch metrics/alarms/logs, CloudTrail events/Lake
- **Cost Gateway** (9 tools) — Cost Explorer, Pricing, Budgets, Forecasts
- **Ops Gateway** (9 tools) — Steampipe SQL, AWS Knowledge, Core MCP

#### Added - Lambda Functions (19) / 추가 - Lambda 함수 (19개)
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

#### Added - Dynamic Routing / 추가 - 동적 라우팅
- `agent.py`: Gateway selection via `payload.gateway` parameter (게이트웨이 선택을 `payload.gateway` 파라미터로 수행)
- `route.ts`: 9-route priority keyword-based routing (9단계 우선순위 키워드 기반 라우팅)
  - Code → Infra → IaC → Data → Security → Monitoring → Cost → AWS Data → Ops
- Role-specific system prompts for each Gateway specialist (각 게이트웨이 전문가별 역할 시스템 프롬프트)

#### Changed / 변경
- Single Gateway (29 tools) → 7 Gateways (125 tools) for better tool selection accuracy (도구 선택 정확도 향상을 위해 단일 게이트웨이에서 7개로 분리)
- `network-mcp` rewritten from 1 tool (693B) to 15 tools (17KB) (1개 도구에서 15개 도구로 재작성)
- `steampipe-query` upgraded from boto3 keyword fallback to real SQL via pg8000 [VPC] (boto3 키워드 폴백에서 pg8000 통한 실제 SQL로 업그레이드)
- Legacy Gateway deleted (`awsops-gateway-g0ihtogknw`) (레거시 게이트웨이 삭제)

#### Added - Installation Scripts / 추가 - 설치 스크립트
- `agent/lambda/create_targets.py` — Python script to create all 19 Gateway Targets
- `agent/lambda/*.py` — All 16 Lambda source files version controlled
- `06b-setup-agentcore-gateway.sh` rewritten for 7 Gateways
- `06c-setup-agentcore-tools.sh` rewritten for 19 Lambda + 19 Targets

---

## [1.0.1] - 2026-03-07

### Deployment & Infrastructure / 배포 및 인프라

#### Added - CDK Infrastructure / 추가 - CDK 인프라
- `infra-cdk/lib/awsops-stack.ts` — VPC, EC2, ALB, CloudFront (CDK)
- `00-deploy-infra.sh` rewritten for CDK (was CloudFormation)
- CDK bootstrap for ap-northeast-2 + us-east-1

#### Added - Authentication / 추가 - 인증
- Cognito User Pool + OAuth2 Authorization Code flow
- Lambda@Edge (Python 3.12, us-east-1) for CloudFront authentication
- `07-setup-cloudfront-auth.sh` — Lambda@Edge → CloudFront `/awsops*` viewer-request

#### Added - AgentCore / 추가 - AgentCore
- AgentCore Runtime (Strands Agent, arm64 Docker, ECR) (Strands 에이전트, arm64 Docker, ECR)
- AgentCore Gateway (MCP protocol) (MCP 프로토콜)
- Code Interpreter (`awsops_code_interpreter`) (코드 인터프리터)
- 4 sub-step scripts: 06a (Runtime), 06b (Gateway), 06c (Tools), 06d (Interpreter) (4개 하위 단계 스크립트)

#### Added - Claude Code Scaffolding / 추가 - Claude Code 스캐폴딩
- `.claude/hooks/check-doc-sync.sh` — Auto-detect missing module docs
- `.claude/skills/sync-docs/SKILL.md` — Full documentation sync skill
- Module CLAUDE.md files: `src/app/`, `src/components/`, `src/lib/`, `src/types/`
- Auto-Sync Rules in root CLAUDE.md
- `docs/architecture.md`, `docs/decisions/.template.md`, `docs/runbooks/.template.md`

#### Added - Git Hooks / 추가 - Git 훅
- `.git/hooks/commit-msg` — Auto-strip Co-Authored-By lines
- `.claude/hooks/install-git-hooks.sh` — Portable hook installer

#### Fixed - CDK Deployment Issues / 수정 - CDK 배포 이슈
- CloudFront CachePolicy: TTL=0 + HeaderBehavior rejected → managed `CACHING_DISABLED`
- ALB SG rules limit: CloudFront prefix list 120+ IPs → port range 80-3000
- EC2 UserData: Steampipe install as root (not ec2-user)
- Steampipe listen mode: `local` → `network` for VPC Lambda access

#### Fixed - AgentCore Known Issues / 수정 - AgentCore 알려진 이슈
- Gateway Target API: `lambdaTargetConfiguration` → `mcp.lambda` structure
- `credentialProviderConfigurations` required (GATEWAY_IAM_ROLE)
- Code Interpreter naming: hyphens → underscores
- Code Interpreter: `networkConfiguration.networkMode` required
- psycopg2 incompatible with Lambda → pg8000 (pure Python)

#### Changed - Documentation / 변경 - 문서
- `ARCHITECTURE.md` — CDK architecture, 10-step installation flow, IAM roles table
- `CLAUDE.md` — Deployment scripts, AgentCore known issues
- `README.md` — 10-step installation, project structure, known issues

---

## [1.0.0] - 2026-03-07

### Initial Release / 최초 릴리스

- AWSops Dashboard with 21 pages + 5 API routes (21개 페이지 + 5개 API 라우트)
- Next.js 14 (App Router) + Tailwind CSS dark theme (다크 테마)
- Steampipe embedded PostgreSQL (380+ AWS tables, 60+ K8s tables) (380+ AWS 테이블, 60+ K8s 테이블)
- Recharts for metrics visualization (메트릭 시각화)
- React Flow for network topology (네트워크 토폴로지)
- Powerpipe CIS v1.5~v4.0 benchmarks (CIS 벤치마크)
- AI routing: Code Interpreter → AgentCore → Steampipe+Bedrock → Bedrock Direct (AI 라우팅)
- Bedrock Sonnet/Opus 4.6 integration (Bedrock 통합)
