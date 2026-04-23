# Architecture

## System Overview
AWSops Dashboard (v1.8.0) is an AWS + Kubernetes operations dashboard providing real-time resource monitoring, network troubleshooting, CIS compliance scanning, AI-powered analysis, external datasource integration (Prometheus/Loki/Tempo/ClickHouse/Jaeger/Dynatrace/Datadog), and AI comprehensive diagnosis. Data is sourced from Steampipe's embedded PostgreSQL, rendered via a Next.js 14 frontend, and augmented with Amazon Bedrock AgentCore for intelligent analysis.

## Components

### Frontend (`src/app/`, `src/components/`)
- **Framework**: Next.js 14 App Router with `basePath: '/awsops'`
- **Styling**: Tailwind CSS dark navy theme with custom accent colors
- **Charts**: Recharts for metrics visualization
- **Topology**: React Flow for network topology diagrams
- **페이지**: 40개 리소스 페이지 (EC2, EBS, S3, VPC, IAM, Lambda, RDS, ECS, MSK, OpenSearch, Inventory, Datasources, AI Diagnosis 등)
  (40 resource pages)
- 멀티 어카운트 지원 (AccountSelector, AccountContext)
- Bedrock 모델 사용량 모니터링, i18n 다국어(ko/en) 지원
- 외부 데이터소스 연동 (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)

### Data Layer (`src/lib/`)
- **Steampipe**: Embedded PostgreSQL on port 9193 — 380+ AWS tables, 60+ K8s tables
- **Connection**: pg Pool (max 10, 120s timeout, sequential batch of 8; see ADR-017)
- **Cache**: node-cache with 5-minute TTL
- **쿼리**: `src/lib/queries/`에 25개 SQL 쿼리 파일 (25 SQL query files)
- **Inventory**: Resource count snapshots (data/inventory/, zero extra queries)
- **Cost Snapshot**: Cost data fallback for MSP accounts (data/cost/)
- **Config**: App config (data/config.json, costEnabled auto-detect)
- **Multi-Account**: Steampipe Aggregator로 복수 계정 쿼리, 캐시키에 accountId 접두사 / Multi-account queries via Steampipe Aggregator, cache key prefixed with accountId
- **External Datasources**: 7종 관측성 플랫폼 HTTP 클라이언트 (SSRF 방지, allowlist, AI 쿼리 생성) / 7 observability platform HTTP clients (SSRF-protected, allowlist, AI query generation)

### AI Layer (`src/app/api/ai/`)
- **Models**: Bedrock Sonnet/Opus 4.6
- **AgentCore**: Runtime (Strands) + 8 Gateways (125 MCP tools via 19 Lambda)
- **Code Interpreter**: Sandboxed code execution for analysis
- **Routing**: 11-route priority system (Code → Network → Container → IaC → Data → Security → Monitoring → Cost → Datasource → AWS → General)
- **Diagnosis**: 15-section Bedrock Opus analysis with DOCX/MD/PDF export and auto-scheduling
- **CloudWatch Metrics API**: MSK, RDS, ElastiCache, OpenSearch — AWS CLI `cloudwatch get-metric-data`로 실시간 메트릭 조회
  (Real-time metrics via AWS CLI for 4 data services)
- **Config 기반 설정**: `data/config.json`에서 `agentRuntimeArn`, `codeInterpreterName`, `costEnabled` 읽기 — 계정별 하드코딩 없음
  (Config-based settings from data/config.json — no hardcoded account ARNs)
- **AI 라우팅 전략**: 목록/현황/구성 분석 → `aws-data` (Steampipe SQL), 트러블슈팅/진단 → 전문 Gateway
  (Routing strategy: listing/analysis → Steampipe SQL, troubleshooting → specialized Gateway)
- **Memory Store**: 대화 이력 영구 저장 (사용자별, 365일 보관) / Conversation history persistence (per-user, 365-day retention)

### Auth & Delivery
- **Auth**: Cognito User Pool + Lambda@Edge (Python 3.12, us-east-1)
- **CDN**: CloudFront → ALB → EC2 (t4g.2xlarge), CachePolicy: CACHING_DISABLED
- **IaC**: CDK (`infra-cdk/`) — AwsopsStack, CognitoStack, AgentCoreStack

### Alert Pipeline (`src/lib/alert-*.ts`, `src/lib/collectors/`)
- **Ingestion**: `/api/alert-webhook` normalizes CloudWatch SNS · Alertmanager · Grafana · Generic into `AlertEvent` (HMAC-SHA256 verified)
- **Poller**: `alert-sqs-poller.ts` consumes SNS→SQS background path (EC2 service), with DLQ handling and rate limiting
- **Correlation**: `alert-correlation.ts` groups alerts into `Incident` objects (30s buffer, time/service/resource matching)
- **Investigation**: `alert-diagnosis.ts` invokes collectors + datasources in parallel with change detection (CloudTrail + K8s rollouts)
- **Notification**: `/api/notification` dispatches to Slack (Block Kit) and SNS (markdown-stripped email), severity-based channel routing
- **Knowledge**: `alert-knowledge.ts` persists diagnosis records to `data/alert-diagnosis/` for similarity search

## Data Flow
1. User requests page → Next.js server renders shell
2. Client-side fetch hits `/awsops/api/steampipe` → pg Pool queries Steampipe
3. Results cached (5 min) → rendered as tables, charts, topology maps
4. AI queries routed through `/awsops/api/ai/` → Bedrock/AgentCore → streamed response

## Infrastructure
- **Compute**: EC2 t4g.2xlarge (ARM64, Graviton) in Private Subnet
- **CDN**: CloudFront with Lambda@Edge auth (viewer-request on /awsops*)
- **Load Balancer**: ALB (SG: CloudFront prefix list, port range 80-3000)
- **Monitoring**: CloudWatch metrics, CloudTrail audit logs
- **SSM**: VPC Endpoints (ssm, ssmmessages, ec2messages) for private access

## Deployment (11 Steps)

| Step | Script | Description |
|------|--------|-------------|
| 0 | `00-deploy-infra.sh` | CDK deploy (VPC, EC2, ALB, CloudFront) |
| 1 | `01-install-base.sh` | Steampipe + Powerpipe |
| 2 | `02-setup-nextjs.sh` | Next.js + Steampipe service |
| 3 | `03-build-deploy.sh` | Production build + start |
| 4 | `04-setup-eks-access.sh` | EKS Access Entry + kubeconfig |
| 5 | `05-setup-cognito.sh` | Cognito User Pool + Lambda@Edge |
| 6a | `06a-setup-agentcore-runtime.sh` | IAM, ECR, Docker, Runtime, Endpoint |
| 6b | `06b-setup-agentcore-gateway.sh` | 8 AgentCore Gateways (role-based MCP routing) |
| 6c | `06c-setup-agentcore-tools.sh` | 19 Lambda + create_targets.py → 125 MCP tools |
| 6d | `06d-setup-agentcore-interpreter.sh` | Code Interpreter |
| 6e | `06e-setup-agentcore-config.sh` | AgentCore config apply (ARN, Gateway URL injection into data/config.json) |
| 6f | `06f-setup-agentcore-memory.sh` | Memory Store (대화 이력 365일 보관) |
| 7 | `07-setup-opencost.sh` | Prometheus + OpenCost (EKS 비용 분석) |
| 8 | `08-setup-cloudfront-auth.sh` | Lambda@Edge → CloudFront 연동 |
| 9 | `09-start-all.sh` | Start all services (steampipe, nextjs, alert-sqs-poller) |
| 10 | `10-stop-all.sh` | Stop all services |
| 11 | `11-verify.sh` | Health check (ports, queries, Gateway responses) |
| 12 | `12-setup-multi-account.sh` | Multi-Account (Target account IAM role + Steampipe connection) |

## AgentCore Gateway Architecture

The AI layer uses 8 role-based Gateways, each with domain-specific Lambda targets and MCP tools:

| Gateway | Tools | Description |
|---------|-------|-------------|
| Network Gateway | 17 | Network analysis: ENI, reachability, flow logs, VPN, TGW |
| Container Gateway | 24 | Containers: EKS cluster/node/pod, ECS service/task, Istio mesh |
| IaC Gateway | 12 | Infrastructure as Code: CDK, CloudFormation, Terraform |
| Data Gateway | 24 | Data & Analytics: DynamoDB, RDS/Aurora, ElastiCache, MSK |
| Security Gateway | 14 | IAM analysis: policy simulation, role policies, trust relationships |
| Monitoring Gateway | 16 | Observability: CloudWatch metrics/alarms/logs, CloudTrail events, datasource diagnostics |
| Cost Gateway | 9 | Cost management: Cost Explorer, forecasts, budgets, FinOps (Compute Optimizer, RI/SP, Trusted Advisor) |
| Ops Gateway | 9 | General operations: AWS docs, CLI, Steampipe SQL |
| **Total** | **125** | **Across 19 Lambda functions** |

Route priority in `src/app/api/ai/route.ts` (11 routes):
1. Code execution keywords → Code Interpreter
2. Network keywords → Network Gateway
3. Container keywords → Container Gateway
4. IaC keywords → IaC Gateway
5. Data & Analytics keywords → Data Gateway
6. Security keywords → Security Gateway
7. Monitoring keywords → Monitoring Gateway
8. Cost keywords → Cost Gateway
9. External datasource keywords → Datasource route (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
10. AWS resource keywords → Steampipe + Bedrock Direct
11. General questions → Ops Gateway (fallback → Bedrock Direct)

## Alert-Triggered AI Diagnosis (Implemented — ADR-009)

Multi-stage AI diagnosis pipeline that automatically receives alerts from external systems (CloudWatch Alarms via SNS, Prometheus Alertmanager webhook, Grafana webhook, SQS queue), correlates related alerts into incidents, investigates root cause using existing collectors (7 types), datasources (7 platforms), and AgentCore gateways (125 MCP tools), then delivers analysis to Slack (Block Kit) and SNS email. Includes knowledge base for past incident reference, change detection (CloudTrail + K8s rollouts), and severity-based channel routing. See [ADR-009](decisions/009-alert-triggered-ai-diagnosis.md) for the full design.

Key pipeline stages:
1. **Ingestion** -- Webhook endpoint normalizes 5 alert source formats into unified `AlertEvent`
2. **Correlation** -- Groups related alerts by resource/service/time-window into `Incident` objects (30s buffering)
3. **Investigation** -- Strategy-selected parallel execution of collectors + datasource queries + change detection
4. **Analysis** -- Bedrock Opus root cause analysis with structured timeline, remediation, and prevention
5. **Knowledge** -- Stores diagnosis records for similarity search on future incidents
6. **Dispatch** -- Slack (severity-routed channels, thread updates), SNS email, dashboard indicator

See also: `scripts/ARCHITECTURE.md` for detailed architecture diagrams.
