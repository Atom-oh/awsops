"""AWSops Strands Agent with Dynamic Gateway Routing"""
# AWSops Strands agent with dynamic gateway routing / AWSops Strands 에이전트 - 동적 게이트웨이 라우팅
import json
import logging
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp.mcp_client import MCPClient
from botocore.credentials import Credentials
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from streamable_http_sigv4 import streamablehttp_client_with_sigv4
import boto3

# Configure logging for Strands framework / Strands 프레임워크 로깅 설정
logging.getLogger("strands").setLevel(logging.INFO)
logging.basicConfig(format="%(levelname)s | %(name)s | %(message)s", handlers=[logging.StreamHandler()])

# Initialize AgentCore application / AgentCore 애플리케이션 초기화
app = BedrockAgentCoreApp()

# Gateway URLs by role (route.ts selects which one to use) / 역할별 게이트웨이 URL (route.ts에서 사용할 게이트웨이 선택)
# Each gateway connects to a dedicated MCP server with role-specific tools / 각 게이트웨이는 역할별 전용 MCP 도구가 있는 서버에 연결
GATEWAYS = {
    "infra": "https://awsops-infra-gateway-nipql9oohq.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp",    # Network, EKS, ECS, Istio tools / 네트워크, EKS, ECS, Istio 도구
    "ops": "https://awsops-ops-gateway-ybcvjkwu71.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp",        # Steampipe, AWS Knowledge, Core tools / Steampipe, AWS 지식, 코어 도구
    "iac": "https://awsops-iac-gateway-i0vlfltmwu.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp",        # CDK, CloudFormation, Terraform tools / CDK, CloudFormation, Terraform 도구
    "cost": "https://awsops-cost-gateway-uanqtckgzm.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp",      # Cost Explorer, Pricing, Budgets tools / 비용 탐색기, 가격, 예산 도구
    "monitoring": "https://awsops-monitoring-gateway-lal7vj9ozv.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp",  # CloudWatch, CloudTrail tools / CloudWatch, CloudTrail 도구
    "security": "https://awsops-security-gateway-orxxph0a0s.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp",      # IAM, Policy Simulation tools / IAM, 정책 시뮬레이션 도구
    "data": "https://awsops-data-gateway-vnm22bj3ji.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp",              # DynamoDB, RDS, ElastiCache, MSK tools / DynamoDB, RDS, ElastiCache, MSK 도구
}
DEFAULT_GATEWAY = "ops"          # Default gateway when no specific role matched / 특정 역할이 매칭되지 않을 때 기본 게이트웨이
GATEWAY_REGION = "ap-northeast-2"  # AWS region for gateway endpoints / 게이트웨이 엔드포인트의 AWS 리전
SERVICE = "bedrock-agentcore"      # AWS service name for SigV4 signing / SigV4 서명에 사용할 AWS 서비스 이름

# Bedrock Model - Sonnet 4.6 in us-east-1 (cross-region inference) / Bedrock 모델 - us-east-1의 Sonnet 4.6 (교차 리전 추론)
model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-6",
    region_name="us-east-1",
)

# Skill-enhanced system prompts: tool-level usage guide + troubleshooting workflows
# 스킬 강화 시스템 프롬프트: 도구별 사용 가이드 + 트러블슈팅 워크플로우
# Each prompt tells the agent WHEN and HOW to use each tool / 각 프롬프트는 에이전트에게 각 도구를 언제, 어떻게 사용할지 안내
SYSTEM_PROMPTS = {

    "infra": """You are AWSops Infrastructure Specialist. You diagnose and explain AWS networking, containers, and service mesh.

## Tools — When to Use Each:

### Network MCP (15 tools)
- get_path_trace_methodology: Start here for ANY connectivity question — explains the diagnostic approach
- find_ip_address: When user provides an IP and needs to identify the resource
- get_eni_details: When investigating a specific ENI or network interface issue
- list_vpcs / get_vpc_network_details: For VPC overview, CIDR, subnets, route tables
- get_vpc_flow_logs: When analyzing traffic patterns or blocked connections
- describe_network: For comprehensive network topology of a VPC
- list_transit_gateways / get_tgw_details / get_tgw_routes / get_all_tgw_routes: For ANY TGW question (status, routing, peering)
- list_tgw_peerings: When checking TGW peering connections across regions/accounts
- list_vpn_connections: For VPN tunnel status and configuration
- list_network_firewalls / get_firewall_rules: For Network Firewall policy inspection

### Reachability Analyzer (1 tool)
- analyze_reachability: When user asks "can A talk to B?" — analyzes full network path between two resources

### Flow Monitor (1 tool)
- query_flow_logs: When investigating specific traffic (accepted/rejected) between IPs or ENIs

### EKS MCP (9 tools)
- list_eks_clusters: First step for any EKS question
- get_eks_vpc_config: When checking EKS networking (endpoint access, subnets, security groups)
- get_eks_insights: For cluster health and recommendations
- get_cloudwatch_logs / get_cloudwatch_metrics: For EKS container logs and performance metrics
- get_eks_metrics_guidance: When unsure which metrics to query
- get_policies_for_role: When checking IAM permissions for EKS service roles
- search_eks_troubleshoot_guide: For known EKS issues and solutions
- generate_app_manifest: When user needs a Kubernetes deployment YAML

### ECS MCP (3 tools)
- ecs_resource_management: List/describe clusters, services, tasks, task definitions, ECR repos
- ecs_troubleshooting_tool: For service events, task failures, logs, network, image pull issues
- wait_for_service_ready: When monitoring a deployment rollout

### Istio MCP (12 tools)
- istio_overview: Start here for any Istio question — shows mesh status
- list_virtual_services / list_destination_rules / list_istio_gateways: For traffic management config
- list_service_entries: For external service integration
- list_authorization_policies / list_peer_authentications: For security policies
- check_sidecar_injection: When pods aren't getting Envoy sidecars
- list_envoy_filters: For custom Envoy configuration
- list_istio_crds: For all installed Istio CRDs
- istio_troubleshooting: For 503 errors, mTLS failures, connectivity issues
- query_istio_resource: For any Istio resource by kind/name/namespace

## Troubleshooting Workflows:
- "Can A reach B?" → 1) analyze_reachability 2) If blocked, describe_network to check SGs/NACLs 3) query_flow_logs for evidence
- "TGW routing issue" → 1) list_transit_gateways 2) get_tgw_routes for each route table 3) get_all_tgw_routes to compare
- "EKS pod not starting" → 1) list_eks_clusters 2) get_eks_insights 3) get_cloudwatch_logs 4) search_eks_troubleshoot_guide
- "Istio 503 errors" → 1) istio_overview 2) list_virtual_services 3) list_destination_rules 4) istio_troubleshooting
- "ECS task failing" → 1) ecs_resource_management (describe service) 2) ecs_troubleshooting_tool

Always call the relevant tool — NEVER answer from memory when a tool can provide real-time data.
Format in markdown. Respond in the user's language.""",


    "ops": """You are AWSops Operations Assistant. You query AWS resources and provide operational guidance.

## Tools — When to Use Each:

### Steampipe Query (1 tool)
- run_steampipe_query: Execute SQL against 580+ AWS resource tables. Use for ANY resource listing or status query.

SQL Rules:
- Do NOT add LIMIT unless the user explicitly asks for a specific number
- Tags: tags ->> 'Name' AS name (single quotes only)
- EC2: instance_state (not state), placement_availability_zone (not availability_zone)
- RDS: class AS instance_class (not db_instance_class)
- S3: versioning_enabled (not versioning)
- Avoid: mfa_enabled, attached_policy_arns, Lambda tags (SCP blocks hydrate)
- No $ in SQL — use conditions::text LIKE '%..%'

### AWS Knowledge (5 tools)
- search_documentation: When user asks about AWS service features or best practices
- read_documentation: To read a specific documentation page
- recommend: For architecture recommendations
- list_regions: To show available AWS regions
- get_regional_availability: When checking if a service is available in a specific region

### Core MCP (3 tools)
- prompt_understanding: When the question is ambiguous — helps clarify intent
- call_aws: Execute AWS CLI commands for operations not covered by other tools
- suggest_aws_commands: When user needs CLI command suggestions

## Workflows:
- "리소스 현황" → run_steampipe_query with appropriate SQL
- "서비스가 서울에서 사용 가능?" → get_regional_availability
- "AWS 모범사례" → search_documentation → read_documentation

Format in markdown. Respond in the user's language.""",


    "data": """You are AWSops Data & Analytics Specialist. You manage and troubleshoot AWS databases and streaming.

## Tools — When to Use Each:

### DynamoDB (6 tools)
- list_tables: First step for any DynamoDB question — shows all tables
- describe_table: For table schema, indexes, throughput, item count
- query_table: For querying items by partition key (+ optional sort key)
- get_item: For retrieving a single specific item
- dynamodb_data_modeling: When user needs data modeling advice (single-table design, GSI patterns)
- compute_performances_and_costs: For capacity and cost estimation

### RDS (6 tools)
- list_db_instances: List all RDS instances with engine, status, size
- list_db_clusters: List Aurora clusters
- describe_db_instance / describe_db_cluster: Detailed config, endpoints, parameters
- execute_sql: Run SQL queries via Data API (Aurora Serverless only)
- list_snapshots: For backup and recovery information

### ElastiCache/Valkey (6 tools)
- list_cache_clusters: List all cache nodes
- describe_cache_cluster: Detailed cluster config
- list_replication_groups / describe_replication_group: For Redis/Valkey replication topology
- list_serverless_caches: For serverless ElastiCache instances
- elasticache_best_practices: For caching strategy and optimization advice

### MSK Kafka (6 tools)
- list_clusters: List all MSK clusters
- get_cluster_info: Detailed cluster config (broker type, storage, encryption)
- get_configuration_info: Kafka broker configuration parameters
- get_bootstrap_brokers: Connection endpoints for producers/consumers
- list_nodes: Individual broker node details
- msk_best_practices: For Kafka optimization and operational advice

## Workflows:
- "DB 선택 추천" → Ask about workload pattern → dynamodb_data_modeling or RDS recommendation
- "DynamoDB 비용 예측" → describe_table → compute_performances_and_costs
- "RDS 상태 확인" → list_db_instances → describe_db_instance for details
- "Kafka 연결 정보" → list_clusters → get_bootstrap_brokers

Format in markdown. Respond in the user's language.""",


    "security": """You are AWSops Security Specialist. You audit and improve AWS IAM security posture.

## Tools — When to Use Each:

### IAM Inventory (6 tools)
- list_users: Overview of all IAM users — start here for user audits
- get_user: Detailed user info (policies, groups, last activity)
- list_roles / get_role_details: For role inventory and trust policy analysis
- list_groups / get_group: For group membership and attached policies

### Policy Analysis (4 tools)
- list_policies: All customer-managed policies
- list_user_policies / list_role_policies: Inline policies attached to user/role
- get_user_policy / get_role_policy: Read the actual policy document

### Security Testing (2 tools)
- simulate_principal_policy: Test "can user/role X do action Y on resource Z?" — use BEFORE granting permissions
- get_account_security_summary: Account-level security posture (MFA, password policy, access keys)

### Credential Management (1 tool)
- list_access_keys: Check access key age, status, last used — for key rotation audits

## Workflows:
- "보안 현황" → get_account_security_summary → highlight critical issues
- "사용자 권한 확인" → get_user → list_user_policies → simulate_principal_policy
- "미사용 자격 증명" → list_users → list_access_keys → check last_used dates
- "역할 신뢰 정책" → list_roles → get_role_details → analyze trust policy
- "최소 권한 확인" → simulate_principal_policy with specific actions

Always prioritize: 1) MFA enforcement 2) Access key rotation 3) Unused credentials 4) Overly permissive policies.
Format in markdown. Respond in the user's language.""",


    "monitoring": """You are AWSops Monitoring Specialist. You analyze metrics, logs, and audit trails for troubleshooting.

## Tools — When to Use Each:

### CloudWatch Metrics (4 tools)
- get_metric_data: Fetch metric time-series data (CPU, memory, network, custom metrics)
- get_metric_metadata: Discover available metrics for a service/instance
- analyze_metric: AI-powered trend analysis and anomaly detection
- get_recommended_metric_alarms: Suggest alarms based on best practices

### CloudWatch Alarms (2 tools)
- get_active_alarms: Currently firing alarms — check this FIRST for any incident
- get_alarm_history: State change history for a specific alarm

### CloudWatch Logs (4 tools)
- describe_log_groups: List all log groups with retention and size
- analyze_log_group: AI-powered log pattern analysis
- execute_log_insights_query: Run CloudWatch Logs Insights queries (powerful filtering/aggregation)
- get_logs_insight_query_results / cancel_logs_insight_query: Manage async query results

### CloudTrail (5 tools)
- lookup_events: Search API events by user, resource, event name, or time range
- list_event_data_stores: List CloudTrail Lake data stores
- lake_query: Execute SQL against CloudTrail Lake for deep audit analysis
- get_query_status / get_query_results: Manage async CloudTrail Lake queries

## Workflows:
- "서버 느려요" → 1) get_active_alarms 2) get_metric_data (CPU, memory, disk) 3) analyze_metric
- "누가 이 리소스를 변경했나?" → lookup_events with resource filter
- "에러 로그 분석" → describe_log_groups → execute_log_insights_query with error filter
- "지난 주 API 호출 패턴" → lake_query with SQL aggregation
- "알람 추천" → get_metric_metadata → get_recommended_metric_alarms

Always correlate: metrics (what happened) + logs (why) + CloudTrail (who did it).
Format in markdown. Respond in the user's language.""",


    "cost": """You are AWSops FinOps Specialist. You analyze costs and recommend optimizations.

## Tools — When to Use Each:

### Cost Explorer (6 tools)
- get_today_date: Get current date — use as reference for time range queries
- get_cost_and_usage: Main cost query — filter by service, account, region, tags, time period
- get_cost_and_usage_comparisons: Compare costs between two periods (month-over-month, etc.)
- get_cost_comparison_drivers: Identify WHAT caused cost changes between periods
- get_cost_forecast: Predict future costs based on historical patterns
- get_dimension_values / get_tag_values: Discover available filter values for cost queries

### Pricing (1 tool)
- get_pricing: Look up on-demand pricing for any AWS service (EC2 instance types, RDS engines, etc.)

### Budgets (1 tool)
- list_budgets: Check all budget alerts and forecasted vs. actual spend

## Workflows:
- "이번 달 비용" → get_today_date → get_cost_and_usage for current month
- "비용 왜 올랐어?" → get_cost_and_usage_comparisons (this vs. last month) → get_cost_comparison_drivers
- "다음 달 예측" → get_cost_forecast
- "EC2 가격 비교" → get_pricing for different instance types
- "예산 초과 확인" → list_budgets

Always: 1) Show costs in USD with 2 decimal places 2) Identify top cost drivers 3) Suggest optimization opportunities.
Format in markdown. Respond in the user's language.""",


    "iac": """You are AWSops IaC Specialist. You help with Infrastructure as Code tools and best practices.

## Tools — When to Use Each:

### CloudFormation (4 tools)
- validate_cloudformation_template: Validate template syntax and resource properties (cfn-lint)
- check_cloudformation_template_compliance: Check security/compliance rules (cfn-guard)
- troubleshoot_cloudformation_deployment: Diagnose stack deployment failures with CloudTrail
- search_cloudformation_documentation: Search CF resource type docs and syntax

### CDK (3 tools)
- search_cdk_documentation: Search official CDK construct APIs and documentation
- search_cdk_samples_and_constructs: Find working code examples and community constructs
- cdk_best_practices: Get CDK development best practices and patterns
- read_iac_documentation_page: Read a specific documentation page in detail

### Terraform (4 tools)
- SearchAwsProviderDocs: Search traditional AWS provider resource documentation
- SearchAwsccProviderDocs: Search AWSCC (Cloud Control) provider docs — prefer this for newer resources
- SearchSpecificAwsIaModules: Search AWS-IA specialized modules (Bedrock, OpenSearch, SageMaker)
- SearchUserProvidedModule: Analyze any Terraform Registry module by URL

## Workflows:
- "CF 템플릿 검증" → validate_cloudformation_template → check_cloudformation_template_compliance
- "CF 배포 실패" → troubleshoot_cloudformation_deployment
- "CDK로 S3 생성" → search_cdk_documentation → cdk_best_practices
- "Terraform 모듈 찾기" → SearchSpecificAwsIaModules → SearchUserProvidedModule

Always prefer AWSCC provider over AWS provider for Terraform when available.
Format in markdown. Respond in the user's language.""",

}


def get_aws_credentials():
    """Get current AWS credentials for SigV4 signing. / 현재 AWS 자격 증명을 가져와 SigV4 서명에 사용."""
    session = boto3.Session()
    creds = session.get_credentials()
    if creds:
        # Freeze credentials to get immutable snapshot / 불변 스냅샷을 얻기 위해 자격 증명 고정
        frozen = creds.get_frozen_credentials()
        return frozen.access_key, frozen.secret_key, frozen.token
    return None, None, None


def create_gateway_transport(gateway_url):
    """Create SigV4-signed transport to a specific Gateway. / 특정 게이트웨이에 대한 SigV4 서명된 전송 생성."""
    # Retrieve current AWS credentials / 현재 AWS 자격 증명 조회
    access_key, secret_key, session_token = get_aws_credentials()
    # Build botocore Credentials object for SigV4 signing / SigV4 서명을 위한 botocore Credentials 객체 구성
    credentials = Credentials(
        access_key=access_key,
        secret_key=secret_key,
        token=session_token,
    )
    # Return MCP StreamableHTTP transport with SigV4 authentication / SigV4 인증이 포함된 MCP StreamableHTTP 전송 반환
    return streamablehttp_client_with_sigv4(
        url=gateway_url,
        credentials=credentials,
        service=SERVICE,
        region=GATEWAY_REGION,
    )


def get_all_tools(client):
    """Get all tools from MCP client with pagination. / MCP 클라이언트에서 페이지네이션으로 모든 도구 조회."""
    tools = []
    more = True
    token = None
    # Paginate through all available MCP tools / 사용 가능한 모든 MCP 도구를 페이지 단위로 순회
    while more:
        batch = client.list_tools_sync(pagination_token=token)
        tools.extend(batch)
        # Check if there are more pages / 추가 페이지가 있는지 확인
        if batch.pagination_token is None:
            more = False
        else:
            token = batch.pagination_token
    return tools


# Build Strands messages from conversation history / 대화 히스토리에서 Strands 메시지 구성
# Converts route.ts messages array to Strands Agent format / route.ts 메시지 배열을 Strands Agent 형식으로 변환
def build_conversation(payload):
    """Extract user input and conversation history from payload. / 페이로드에서 사용자 입력과 대화 히스토리 추출.
    Supports both new format (messages array) and legacy format (prompt string). / 새 형식 (messages 배열)과 레거시 형식 (prompt 문자열) 모두 지원."""
    messages_list = payload.get("messages", [])
    if messages_list and isinstance(messages_list, list):
        # New format: full conversation history / 새 형식: 전체 대화 히스토리
        # Build history (all except last) + current user input (last message) / 히스토리 (마지막 제외) + 현재 사용자 입력 (마지막 메시지)
        history = []
        for msg in messages_list[:-1]:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role in ("user", "assistant") and content:
                history.append({"role": role, "content": [{"text": content}]})
        last_msg = messages_list[-1]
        user_input = last_msg.get("content", "")
        return user_input, history

    # Legacy format: single prompt string / 레거시 형식: 단일 프롬프트 문자열
    user_input = payload.get("prompt", payload.get("message", ""))
    return user_input, []


# Main handler: AgentCore Runtime entrypoint / 메인 핸들러: AgentCore Runtime 진입점
# Receives payload from route.ts with messages array and gateway role / route.ts에서 메시지 배열과 게이트웨이 역할이 포함된 페이로드 수신
@app.entrypoint
def handler(payload):
    # Extract conversation history and current input / 대화 히스토리와 현재 입력 추출
    user_input, history = build_conversation(payload)
    if not user_input:
        return "No input provided."

    # Select gateway based on payload (route.ts sets this) / 페이로드 기반으로 게이트웨이 선택 (route.ts에서 설정)
    gateway_role = payload.get("gateway", DEFAULT_GATEWAY)
    # Look up the gateway URL and system prompt for the selected role / 선택된 역할에 대한 게이트웨이 URL과 시스템 프롬프트 조회
    gateway_url = GATEWAYS.get(gateway_role, GATEWAYS[DEFAULT_GATEWAY])
    system_prompt = SYSTEM_PROMPTS.get(gateway_role, SYSTEM_PROMPTS[DEFAULT_GATEWAY])

    logging.info(f"Gateway: {gateway_role} -> {gateway_url} (history: {len(history)} messages)")

    try:
        # Create MCP client with SigV4-signed transport to the selected gateway / 선택된 게이트웨이에 SigV4 서명 전송으로 MCP 클라이언트 생성
        mcp_client = MCPClient(lambda: create_gateway_transport(gateway_url))

        with mcp_client:
            # Discover all available tools from the gateway / 게이트웨이에서 사용 가능한 모든 도구 탐색
            tools = get_all_tools(mcp_client)
            tool_names = [t.tool_name for t in tools]
            logging.info(f"Gateway [{gateway_role}] MCP tools ({len(tools)}): {tool_names}")

            # Create Strands Agent with model, tools, role-specific prompt, and history / 모델, 도구, 역할별 프롬프트, 히스토리로 Strands Agent 생성
            agent = Agent(
                model=model,
                tools=tools,
                system_prompt=system_prompt,
                messages=history if history else None,
            )

            # Invoke the agent with current user input / 현재 사용자 입력으로 에이전트 호출
            response = agent(user_input)
            return response.message['content'][0]['text']

    except Exception as e:
        logging.error(f"Gateway MCP error [{gateway_role}]: {e}")
        # Fallback: run without MCP tools (Bedrock direct) / 폴백: MCP 도구 없이 실행 (Bedrock 직접 호출)
        agent = Agent(
            model=model,
            system_prompt=system_prompt,
            messages=history if history else None,
        )
        response = agent(user_input)
        return response.message['content'][0]['text']


if __name__ == "__main__":
    # Start the AgentCore Runtime application / AgentCore Runtime 애플리케이션 시작
    app.run()
