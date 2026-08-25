# Agent Module

## Role
Strands Agent for AgentCore Runtime. Connects to 8 role-based Gateways via MCP protocol.

## Key Files
- `agent.py` — Main entrypoint: dynamic Gateway selection via the `payload.gateway` parameter
- `streamable_http_sigv4.py` — MCP StreamableHTTP with AWS SigV4 signing
- `Dockerfile` — Python 3.11-slim, arm64, port 8080
- `requirements.txt` — strands-agents, boto3, bedrock-agentcore, psycopg2-binary
- `lambda/` — 19 Lambda source files + `create_targets.py`

## 8 Gateways

| Gateway | Tools | Description |
|---------|-------|-------------|
| **Network** | 17 | VPC, TGW, VPN, ENI, Reachability, Flow Logs |
| **Container** | 24 | EKS, ECS, ECR, Istio service mesh |
| **IaC** | 12 | CloudFormation, CDK, Terraform |
| **Data** | 24 | DynamoDB, RDS, ElastiCache, MSK |
| **Security** | 14 | IAM users/roles/policies, simulation |
| **Monitoring** | 16 | CloudWatch metrics/alarms/logs, CloudTrail, Datasource diagnostics |
| **Cost** | 9 | Cost Explorer, Pricing, Budgets, FinOps (Compute Optimizer, RI/SP, Trusted Advisor) |
| **Ops** | 9 | AWS docs, CLI, Steampipe SQL |
| **Total** | **125** | Across 19 Lambda functions |

## 11 Routes (route.ts)

1. `code` — Code Interpreter (Python sandbox)
2. `network` — Network Gateway (VPC, TGW, VPN, ENI, Flow Logs)
3. `container` — Container Gateway (EKS, ECS, Istio)
4. `iac` — IaC Gateway (CloudFormation, CDK, Terraform)
5. `data` — Data Gateway (DynamoDB, RDS, ElastiCache, MSK)
6. `security` — Security Gateway (IAM, policies, simulation)
7. `monitoring` — Monitoring Gateway (CloudWatch, CloudTrail)
8. `cost` — Cost Gateway (Cost Explorer, Pricing, Budgets, FinOps)
9. `datasource` — External datasources (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
10. `aws-data` — Steampipe SQL + Bedrock (resource inventory queries)
11. `general` — Ops Gateway + Bedrock fallback

## Multi-Route Support
- The classifier returns 1–3 routes.
- Parallel gateway calls + result synthesis.
- Real-time response delivery via SSE streaming.

## Rules
- Docker image must be arm64 (`docker buildx --platform linux/arm64`).
- Gateway URL is selected dynamically from the `GATEWAYS` dict based on the payload.
- The system prompt is role-specific: network/container/iac/data/security/monitoring/cost/ops.
- Fallback: if the MCP connection fails, run without tools — direct Bedrock call.
