# Changelog

All notable changes to the AWSops Dashboard project.

---

## [1.1.0] - 2026-03-07

### AgentCore MCP Gateway Architecture

Complete redesign from single Gateway to 7 role-based Gateways with 125 MCP tools.

#### Added - Gateways (7)
- **Infra Gateway** (41 tools) — Network, EKS, ECS, Istio
- **IaC Gateway** (12 tools) — CloudFormation, CDK, Terraform
- **Data Gateway** (24 tools) — DynamoDB, RDS MySQL/PostgreSQL, ElastiCache/Valkey, MSK Kafka
- **Security Gateway** (14 tools) — IAM users, roles, groups, policies, simulation
- **Monitoring Gateway** (16 tools) — CloudWatch metrics/alarms/logs, CloudTrail events/Lake
- **Cost Gateway** (9 tools) — Cost Explorer, Pricing, Budgets, Forecasts
- **Ops Gateway** (9 tools) — Steampipe SQL, AWS Knowledge, Core MCP

#### Added - Lambda Functions (19)
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

#### Added - Dynamic Routing
- `agent.py`: Gateway selection via `payload.gateway` parameter
- `route.ts`: 9-route priority keyword-based routing
  - Code → Infra → IaC → Data → Security → Monitoring → Cost → AWS Data → Ops
- Role-specific system prompts for each Gateway specialist

#### Changed
- Single Gateway (29 tools) → 7 Gateways (125 tools) for better tool selection accuracy
- `network-mcp` rewritten from 1 tool (693B) to 15 tools (17KB)
- `steampipe-query` upgraded from boto3 keyword fallback to real SQL via pg8000 [VPC]
- Legacy Gateway deleted (`awsops-gateway-g0ihtogknw`)

#### Added - Installation Scripts
- `agent/lambda/create_targets.py` — Python script to create all 19 Gateway Targets
- `agent/lambda/*.py` — All 16 Lambda source files version controlled
- `06b-setup-agentcore-gateway.sh` rewritten for 7 Gateways
- `06c-setup-agentcore-tools.sh` rewritten for 19 Lambda + 19 Targets

---

## [1.0.1] - 2026-03-07

### Deployment & Infrastructure

#### Added - CDK Infrastructure
- `infra-cdk/lib/awsops-stack.ts` — VPC, EC2, ALB, CloudFront (CDK)
- `00-deploy-infra.sh` rewritten for CDK (was CloudFormation)
- CDK bootstrap for ap-northeast-2 + us-east-1

#### Added - Authentication
- Cognito User Pool + OAuth2 Authorization Code flow
- Lambda@Edge (Python 3.12, us-east-1) for CloudFront authentication
- `07-setup-cloudfront-auth.sh` — Lambda@Edge → CloudFront `/awsops*` viewer-request

#### Added - AgentCore
- AgentCore Runtime (Strands Agent, arm64 Docker, ECR)
- AgentCore Gateway (MCP protocol)
- Code Interpreter (`awsops_code_interpreter`)
- 4 sub-step scripts: 06a (Runtime), 06b (Gateway), 06c (Tools), 06d (Interpreter)

#### Added - Claude Code Scaffolding
- `.claude/hooks/check-doc-sync.sh` — Auto-detect missing module docs
- `.claude/skills/sync-docs/SKILL.md` — Full documentation sync skill
- Module CLAUDE.md files: `src/app/`, `src/components/`, `src/lib/`, `src/types/`
- Auto-Sync Rules in root CLAUDE.md
- `docs/architecture.md`, `docs/decisions/.template.md`, `docs/runbooks/.template.md`

#### Added - Git Hooks
- `.git/hooks/commit-msg` — Auto-strip Co-Authored-By lines
- `.claude/hooks/install-git-hooks.sh` — Portable hook installer

#### Fixed - CDK Deployment Issues
- CloudFront CachePolicy: TTL=0 + HeaderBehavior rejected → managed `CACHING_DISABLED`
- ALB SG rules limit: CloudFront prefix list 120+ IPs → port range 80-3000
- EC2 UserData: Steampipe install as root (not ec2-user)
- Steampipe listen mode: `local` → `network` for VPC Lambda access

#### Fixed - AgentCore Known Issues
- Gateway Target API: `lambdaTargetConfiguration` → `mcp.lambda` structure
- `credentialProviderConfigurations` required (GATEWAY_IAM_ROLE)
- Code Interpreter naming: hyphens → underscores
- Code Interpreter: `networkConfiguration.networkMode` required
- psycopg2 incompatible with Lambda → pg8000 (pure Python)

#### Changed - Documentation
- `ARCHITECTURE.md` — CDK architecture, 10-step installation flow, IAM roles table
- `CLAUDE.md` — Deployment scripts, AgentCore known issues
- `README.md` — 10-step installation, project structure, known issues

---

## [1.0.0] - 2026-03-07

### Initial Release

- AWSops Dashboard with 21 pages + 5 API routes
- Next.js 14 (App Router) + Tailwind CSS dark theme
- Steampipe embedded PostgreSQL (380+ AWS tables, 60+ K8s tables)
- Recharts for metrics visualization
- React Flow for network topology
- Powerpipe CIS v1.5~v4.0 benchmarks
- AI routing: Code Interpreter → AgentCore → Steampipe+Bedrock → Bedrock Direct
- Bedrock Sonnet/Opus 4.6 integration
