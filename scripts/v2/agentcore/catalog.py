"""AWSops v2 P1f — AgentCore skeleton catalog (MID-minus).

GATEWAYS: 9 domain gateways. 8 reuse v1-stable names (agent.py auto-discovers by
stripping 'awsops-'/'-gateway'); 'external-obs' is the NEW §4 #7 split, left EMPTY in
P1f (its plugin datasource registry + OTLP + datasource-diag re-home are P3).

TARGETS: the representative read-only slice proving every provisioner code path:
  - iam-mcp (14 tools, cross-account, largest schema) -> security gateway
  - flow-monitor (1 tool, single-tool, proves for_each>=2) -> network gateway
Schemas are copied verbatim from agent/lambda/create_targets.py. provision.py injects
target_account_id into every tool inputSchema (cross-account), exactly like v1.
"""

# short-key -> gateway display name. provision.py builds 'awsops-<key>-gateway'.
GATEWAYS = [
    "network", "container", "data", "security", "cost",
    "monitoring", "iac", "ops", "external-obs",
]

GATEWAY_DESCRIPTIONS = {
    "network": "VPC, ENI, reachability, flow logs, TGW, VPN, firewall",
    "container": "EKS, ECS, Istio, Kubernetes",
    "data": "DynamoDB, RDS/Aurora, ElastiCache, MSK, OpenSearch",
    "security": "IAM, policy simulation, CIS/benchmark (P3)",
    "cost": "Cost Explorer, forecast, budgets, container cost",
    "monitoring": "CloudWatch, CloudTrail (AWS native only)",
    "iac": "CloudFormation, CDK, Terraform",
    "ops": "Steampipe SQL listing/status/docs/inventory",
    "external-obs": "External Observability (Prometheus/Loki/Tempo/...) — registry built in P3",
}


def _p(t, d=""):
    r = {"type": t}
    if d:
        r["description"] = d
    return r


# target_name -> {gateway, lambda_key (matches terraform output agentcore.lambda_arns), description, tools[]}
TARGETS = {
    "iam-mcp-target": {
        "gateway": "security",
        "lambda_key": "iam-mcp",
        "description": "IAM users, roles, groups, policies, simulation (14 tools)",
        "tools": [
            {"name": "list_users", "description": "List IAM users", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "get_user", "description": "User details", "inputSchema": {"type": "object", "properties": {"user_name": _p("string", "User")}, "required": ["user_name"]}},
            {"name": "list_roles", "description": "List roles", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "get_role_details", "description": "Role details", "inputSchema": {"type": "object", "properties": {"role_name": _p("string", "Role")}, "required": ["role_name"]}},
            {"name": "list_groups", "description": "List groups", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "get_group", "description": "Group details", "inputSchema": {"type": "object", "properties": {"group_name": _p("string", "Group")}, "required": ["group_name"]}},
            {"name": "list_policies", "description": "List policies", "inputSchema": {"type": "object", "properties": {"scope": _p("string", "Local/AWS/All")}}},
            {"name": "list_user_policies", "description": "User policies", "inputSchema": {"type": "object", "properties": {"user_name": _p("string", "User")}, "required": ["user_name"]}},
            {"name": "list_role_policies", "description": "Role policies", "inputSchema": {"type": "object", "properties": {"role_name": _p("string", "Role")}, "required": ["role_name"]}},
            {"name": "get_user_policy", "description": "User inline policy", "inputSchema": {"type": "object", "properties": {"user_name": _p("string", "User"), "policy_name": _p("string", "Policy")}, "required": ["user_name", "policy_name"]}},
            {"name": "get_role_policy", "description": "Role inline policy", "inputSchema": {"type": "object", "properties": {"role_name": _p("string", "Role"), "policy_name": _p("string", "Policy")}, "required": ["role_name", "policy_name"]}},
            {"name": "list_access_keys", "description": "Access keys", "inputSchema": {"type": "object", "properties": {"user_name": _p("string", "User")}, "required": ["user_name"]}},
            {"name": "simulate_principal_policy", "description": "Policy simulation", "inputSchema": {"type": "object", "properties": {"policy_source_arn": _p("string", "ARN"), "action_names": _p("string", "Actions")}, "required": ["policy_source_arn", "action_names"]}},
            {"name": "get_account_security_summary", "description": "Account security summary", "inputSchema": {"type": "object", "properties": {}}},
        ],
    },
    "flow-monitor-target": {
        "gateway": "network",
        "lambda_key": "flow-monitor",
        "description": "VPC Flow Log analyzer (1 tool)",
        "tools": [
            {"name": "query_flow_logs", "description": "Query flow logs", "inputSchema": {"type": "object", "properties": {"vpc_id": _p("string", "VPC ID")}, "required": ["vpc_id"]}},
        ],
    },
}
