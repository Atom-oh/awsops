# Lambda Module / Lambda 모듈

## Role / 역할
19 Lambda functions for AgentCore Gateway MCP tools. Each Lambda implements specific AWS service operations.
(AgentCore 게이트웨이 MCP 도구용 19개 Lambda 함수. 각 Lambda는 특정 AWS 서비스 작업을 구현.)

## Key Files / 주요 파일
- `create_targets.py` — Creates all 19 Gateway Targets across 7 Gateways (Python/boto3) (7개 게이트웨이에 걸쳐 19개 게이트웨이 타겟 생성)
- `network_mcp.py` — VPC, TGW, VPN, ENI, Network Firewall (15 tools / 15개 도구)
- `aws_eks_mcp.py` — EKS clusters, CloudWatch, IAM, troubleshooting (9 tools / 9개 도구)
- `aws_ecs_mcp.py` — ECS clusters/services/tasks, troubleshooting (3 tools / 3개 도구)
- `aws_istio_mcp.py` [VPC] — Istio CRDs via Steampipe K8s tables (12 tools / 12개 도구)
- `aws_iac_mcp.py` — CloudFormation/CDK validation, troubleshooting, docs (7 tools / 7개 도구)
- `aws_terraform_mcp.py` — Provider docs, Registry module search (5 tools / 5개 도구)
- `aws_iam_mcp.py` — IAM users/roles/groups/policies, simulation (14 tools / 14개 도구)
- `aws_cloudwatch_mcp.py` — Metrics, alarms, Log Insights (11 tools / 11개 도구)
- `aws_cloudtrail_mcp.py` — Event lookup, CloudTrail Lake (5 tools / 5개 도구)
- `aws_cost_mcp.py` — Cost Explorer, Pricing, Budgets (9 tools / 9개 도구)
- `aws_dynamodb_mcp.py` — Tables, queries, data modeling, costs (6 tools / 6개 도구)
- `aws_rds_mcp.py` — RDS/Aurora instances, SQL via Data API (6 tools / 6개 도구)
- `aws_valkey_mcp.py` — ElastiCache clusters, replication groups (6 tools / 6개 도구)
- `aws_msk_mcp.py` — MSK Kafka clusters, brokers, configs (6 tools / 6개 도구)
- `aws_knowledge.py` — Proxy to AWS Knowledge MCP (AWS Knowledge MCP 프록시, 5 tools / 5개 도구)
- `aws_core_mcp.py` — Prompt understanding, AWS CLI execution (프롬프트 이해, AWS CLI 실행, 3 tools / 3개 도구)

## Rules / 규칙
- Gateway Targets: must use Python/boto3 (CLI has inlinePayload issues)
  (게이트웨이 타겟: Python/boto3 사용 필수 — CLI는 inlinePayload 문제 있음)
- `credentialProviderConfigurations: GATEWAY_IAM_ROLE` required for all targets
  (모든 타겟에 `credentialProviderConfigurations: GATEWAY_IAM_ROLE` 필수)
- VPC Lambda (steampipe-query, istio-mcp): pg8000, not psycopg2
  (VPC Lambda: psycopg2 대신 pg8000 사용)
- All Lambda read-only (no write operations except reachability path creation)
  (모든 Lambda는 읽기 전용 — 도달성 경로 생성 외 쓰기 작업 없음)
- Tool schemas: `inlinePayload: [{name, description, inputSchema: {type, properties, required}}]`
  (도구 스키마 형식)
