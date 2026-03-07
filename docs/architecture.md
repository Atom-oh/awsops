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
- **AgentCore**: Runtime (Strands) + Gateway MCP (20 tools)
- **Code Interpreter**: Sandboxed code execution for analysis
- **Routing**: 4-route priority system (Code → Network → AWS → General)

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
| 6b | `06b-setup-agentcore-gateway.sh` | AgentCore Gateway (MCP) |
| 6c | `06c-setup-agentcore-tools.sh` | 4 Lambda + 4 Gateway Targets |
| 6d | `06d-setup-agentcore-interpreter.sh` | Code Interpreter |
| 7 | `07-setup-cloudfront-auth.sh` | Lambda@Edge → CloudFront 연동 |

See also: `scripts/ARCHITECTURE.md` for detailed architecture diagrams.
