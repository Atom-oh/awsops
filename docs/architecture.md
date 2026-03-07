# Architecture

## System Overview
AWSops Dashboard is an AWS + Kubernetes operations dashboard providing real-time resource monitoring, network troubleshooting, CIS compliance scanning, and AI-powered analysis. Data is sourced from Steampipe's embedded PostgreSQL, rendered via a Next.js 14 frontend, and augmented with Amazon Bedrock AgentCore for intelligent analysis.

## Components

### Frontend (`src/app/`, `src/components/`)
- **Framework**: Next.js 14 App Router with `basePath: '/awsops'`
- **Styling**: Tailwind CSS dark navy theme with custom accent colors
- **Charts**: Recharts for metrics visualization
- **Topology**: React Flow for network topology diagrams
- **Pages**: 15+ resource pages (EC2, S3, VPC, IAM, Lambda, RDS, ECS, etc.)

### Data Layer (`src/lib/`)
- **Steampipe**: Embedded PostgreSQL on port 9193 — 380+ AWS tables, 60+ K8s tables
- **Connection**: pg Pool (max 3, 120s timeout, sequential batch)
- **Cache**: node-cache with 5-minute TTL
- **Queries**: 16 SQL query files in `src/lib/queries/`

### AI Layer (`src/app/api/ai/`)
- **Models**: Bedrock Sonnet/Opus 4.6
- **AgentCore**: Runtime (Strands) + 7 Gateways (125 MCP tools via 19 Lambda)
- **Code Interpreter**: Sandboxed code execution for analysis
- **Routing**: 9-route priority system (Code → Infra → IaC → Data → Security → Monitoring → Cost → AWS → General)

### Auth & Delivery
- **Auth**: Cognito User Pool + Lambda@Edge (Python 3.12, us-east-1)
- **CDN**: CloudFront → ALB → EC2 (t4g.2xlarge), CachePolicy: CACHING_DISABLED
- **IaC**: CDK (`infra-cdk/`) — AwsopsStack, CognitoStack, AgentCoreStack(placeholder)

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

## Deployment (10 Steps)

| Step | Script | Description |
|------|--------|-------------|
| 0 | `00-deploy-infra.sh` | CDK deploy (VPC, EC2, ALB, CloudFront) |
| 1 | `01-install-base.sh` | Steampipe + Powerpipe |
| 2 | `02-setup-nextjs.sh` | Next.js + Steampipe service |
| 3 | `03-build-deploy.sh` | Production build + start |
| 5 | `05-setup-cognito.sh` | Cognito User Pool + Lambda@Edge |
| 6a | `06a-setup-agentcore-runtime.sh` | IAM, ECR, Docker, Runtime, Endpoint |
| 6b | `06b-setup-agentcore-gateway.sh` | 7 AgentCore Gateways (role-based MCP routing) |
| 6c | `06c-setup-agentcore-tools.sh` | 19 Lambda + create_targets.py → 125 MCP tools |
| 6d | `06d-setup-agentcore-interpreter.sh` | Code Interpreter |
| 7 | `07-setup-cloudfront-auth.sh` | Lambda@Edge → CloudFront 연동 |

## AgentCore Gateway Architecture

The AI layer uses 7 role-based Gateways, each with domain-specific Lambda targets and MCP tools:

| Gateway | Tools | Description |
|---------|-------|-------------|
| Infra Gateway | 12 | Network analysis: ENI, reachability, flow logs, route tables, VPN, TGW, NACLs |
| IaC Gateway | 16 | Infrastructure as Code: CDK, CloudFormation, Terraform, Checkov scanning |
| Data Gateway | 24 | Data & Analytics: DynamoDB, RDS/Aurora, ElastiCache, MSK, Steampipe queries |
| Security Gateway | 14 | IAM analysis: policy simulation, role policies, access advisor, trust relationships |
| Monitoring Gateway | 16 | Observability: CloudWatch metrics/alarms/logs, CloudTrail events, dashboards |
| Cost Gateway | 9 | Cost management: Cost Explorer, forecasts, budgets, savings plans |
| Ops Gateway | 9 | General operations: EC2, S3, ECS, Lambda overview and Istio/EKS |
| **Total** | **125** | **Across 19 Lambda functions** |

Route priority in `src/app/api/ai/route.ts`:
1. Code execution keywords → Code Interpreter
2. Infrastructure keywords → Infra Gateway
3. IaC keywords → IaC Gateway
4. Data & Analytics keywords → Data Gateway
5. Security keywords → Security Gateway
6. Monitoring keywords → Monitoring Gateway
7. Cost keywords → Cost Gateway
8. AWS resource keywords → Steampipe + Bedrock Direct
9. General questions → Ops Gateway (fallback → Bedrock Direct)

See also: `scripts/ARCHITECTURE.md` for detailed architecture diagrams.
