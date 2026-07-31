# Lambda 모듈 / Lambda Module

## 역할 / Role
AgentCore 게이트웨이 MCP 도구용 Lambda 함수 + 공유 모듈. 각 Lambda는 특정 AWS 서비스 작업을 구현.
(Lambda functions + shared modules for AgentCore Gateway MCP tools. +3 v2 read-only sources added
2026-06-18: core_helpers / reachability_read / istio_read — see the per-gateway lists below.)

## 주요 파일 / Key Files
- `create_targets.py` — 8개 게이트웨이에 걸쳐 20개 게이트웨이 타겟 생성 (Creates all 20 Gateway Targets across 8 Gateways, Python/boto3)
- `cross_account.py` — 크로스 어카운트 STS AssumeRole 헬퍼 (credential 캐싱 50분, ExternalId, 감사 로그) (Cross-account credential helper with caching, audit logging)

### Network Gateway (17 v1 + reachability-read 1 = 18)
- `network_mcp.py` — VPC, TGW, VPN, ENI, Network Firewall (15 tools)
- `reachability.py` — Reachability Analyzer (1 tool) — ⚠️ v1, **dark in v2** (creates a network-insights path = mutation)
- `reachability_read_mcp.py` [v2 read-only] — computed ENI↔EC2 connectivity, describe-only, static SG/NACL/route (1 tool: `check_reachability`)
- `flowmonitor.py` — VPC Flow Logs 조회/분석 (1 tool)

### Container Gateway (24 v1 + istio-read 7 = 31)
- `aws_eks_mcp.py` — EKS clusters, CloudWatch, IAM, troubleshooting (9 tools)
- `aws_ecs_mcp.py` — ECS clusters/services/tasks, troubleshooting (3 tools)
- `aws_istio_mcp.py` [VPC] — Istio CRDs via Steampipe K8s tables (12 tools) — ⚠️ v1, **dark in v2** (needs live Steampipe, ADR-037)
- `istio_read_mcp.py` [v2 read-only] — Istio CRDs via the EKS k8s API (presigned-STS token, stdlib urllib/ssl; 7 tools: mesh_overview + 6 CRD lists). Needs an EKS Access Entry for the agent Lambda role — registered out-of-band by the cluster owner via `scripts/v2/eks/register-istio-access.sh` (docs/runbooks/istio-agent-eks-access.md), NOT terraform.

### IaC Gateway (12 tools)
- `aws_iac_mcp.py` — CloudFormation/CDK validation, troubleshooting, docs (7 tools)
- `aws_terraform_mcp.py` — Provider docs, Registry module search (5 tools)

### Data Gateway (24 tools)
- `aws_dynamodb_mcp.py` — Tables, queries, data modeling, costs (6 tools)
- `aws_rds_mcp.py` — RDS/Aurora instances, SQL via Data API (6 tools). **`execute_sql`의 read-only 보장은 DB 롤 권한에 있다** (아래 참조) / **`execute_sql`'s read-only guarantee rests on DB-level role permissions** (see below)
- `aws_valkey_mcp.py` — ElastiCache clusters, replication groups (6 tools)
- `aws_msk_mcp.py` — MSK Kafka clusters, brokers, configs (6 tools)

### Security Gateway (14 tools)
- `aws_iam_mcp.py` — IAM users/roles/groups/policies, simulation (14 tools)

### Monitoring Gateway (24 tools)
- `aws_cloudwatch_mcp.py` — Metrics, alarms, Log Insights (11 tools)
- `aws_cloudtrail_mcp.py` — Event lookup, CloudTrail Lake (5 tools)
- `datasource_diag_mcp.py` — 데이터소스 연결 진단 (Datasource connectivity diagnostics, 8 tools: URL validation, DNS, NLB targets, SG analysis, network path, HTTP connectivity, K8s endpoints, full diagnosis)

### Cost Gateway (14 tools)
- `aws_cost_mcp.py` — Cost Explorer, Pricing, Budgets (9 tools)
- `aws_finops_mcp.py` — Compute Optimizer, RI/SP Recommendations, Cost Optimization Hub, Trusted Advisor (5 tools)

### Ops Gateway (9 v1 + core-helpers 2 = 11)
- `aws_knowledge.py` — AWS Knowledge MCP 프록시 (Proxy to AWS Knowledge MCP, 5 tools)
- `aws_core_mcp.py` — 프롬프트 이해, AWS CLI 실행 (3 tools) — ⚠️ `call_aws` arbitrary-CLI is a mutation vector; **dark in v2**
- `core_helpers_mcp.py` [v2 read-only] — prompt_understanding + suggest_aws_commands only (2 static tools; no `call_aws`)
- `steampipe-query` — Steampipe SQL 쿼리 (1 tool, VPC Lambda)

## 규칙 / Rules
- 게이트웨이 타겟: Python/boto3 사용 필수 — CLI는 inlinePayload 문제 있음
  (Gateway Targets: must use Python/boto3 — CLI has inlinePayload issues)
- 모든 타겟에 `credentialProviderConfigurations: GATEWAY_IAM_ROLE` 필수
  (`credentialProviderConfigurations: GATEWAY_IAM_ROLE` required for all targets)
- VPC Lambda: psycopg2 대신 pg8000 사용 (steampipe-query, istio-mcp)
  (VPC Lambda: pg8000, not psycopg2)
- 모든 Lambda는 읽기 전용 — **v2는 예외 없음** (v1의 "도달성 경로 생성" 쓰기 예외는 v2에서 dark; `reachability_read_mcp.py`가 describe-only로 대체)
  (All Lambda read-only — **no exceptions in v2**; the v1 reachability path-creation write is dark, replaced by describe-only `reachability_read_mcp.py`)
- 도구 스키마 형식: `inlinePayload: [{name, description, inputSchema: {type, properties, required}}]`
  (Tool schema format)

## `execute_sql` — read-only 경계는 DB 롤이다 / the read-only boundary is a DB role

**요약: 어휘 가드(`sql_readonly_guard.py`)는 경계가 아니라 defense-in-depth다.**
(**TL;DR: the lexical guard is defense-in-depth, NOT the boundary.**)

- `aws_rds_mcp.py`의 `execute_sql`과 `inventory_read_mcp.py`는 RDS Data API로 앱 자신의 Aurora에 접속한다.
  자격증명은 **Aurora master secret이 아니라** 전용 최소권한 롤 **`awsops_sql_reader`** secret이다
  (`AURORA_SQL_READER_SECRET_ARN` / `AURORA_SECRET_ARN` env, `ai.tf`가 주입). 호출자가 넘긴 `secret_arn`
  인자는 **무시**되며 도구 스키마에서도 제거됐다 — 자격증명 선택은 서버 설정이지 모델 입력이 아니다.
  env 미설정 시 **fail-closed**(더 높은 권한으로 폴백하지 않음).
- 롤 권한: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  `CONNECT`(awsops) + `USAGE`(public) + `SELECT`(public 테이블) **만**, `default_transaction_read_only=on`,
  EXECUTE 부여 0건, predefined-role 멤버십 0건.
  → `terraform/v2/foundation/migrations/01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql`
- agent Lambda IAM 롤에는 master secret `GetSecretValue`가 **없다**(`ai.tf` `agent_lambda_inventory`).
  어휘 가드를 우회해도 **권한 없는 세션**에 도달할 뿐이다.
- **왜**: PR #197 리뷰 3~7라운드가 매번 새 우회를 찾았다. 원인은 denylist가 열거할 수 없는 부류 —
  SQL을 *문자열 인자*로 받아 실행하는 코어 함수(`query_to_xml('SELECT pg_cancel_backend(...)')`)는
  가드가 문자열 리터럴을 매칭 전에 제거하므로 보이지 않고, `SET TRANSACTION READ ONLY`는 데이터 쓰기만
  막아 control-plane 호출을 허용한다.
- **그러므로 이 파일들에 DANGER 항목을 더 추가해 "완전"하게 만들려 하지 말 것.** 새 어휘 구멍은
  권한상승이 아니다(ClickHouse 커넥터는 아직 DB-롤 경계가 없어 그쪽에선 가드가 여전히 1차 방어다).

(English) `execute_sql` / `inventory-read` authenticate as the dedicated `awsops_sql_reader` role
(NOSUPERUSER, CONNECT+USAGE+SELECT only, `default_transaction_read_only=on`, no EXECUTE grants), via
its own secret — the caller-supplied `secret_arn` is ignored and gone from the tool schema, and an
unset env fails closed with no fallback. The agent Lambda role has **no** `GetSecretValue` on the
Aurora master secret, so a lexical-guard bypass now lands in an unprivileged session. Do not grow the
DANGER denylist hoping to make it exhaustive — "functions that execute a string" is unbounded. The
ClickHouse connector has no equivalent DB-role boundary yet, so there the guard is still primary.
Detail: ADR-004 §7 amendment (2026-07-31).
