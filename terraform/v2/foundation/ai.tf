# AWSops v2 — P1f AgentCore provisioner (Terraform-native parts).
# AgentCore control-plane resources (Runtime/Gateway/Target/Memory/Interpreter) are NOT
# Terraform-native — they are created by scripts/v2/agentcore/provision.py after apply.
# Everything here is gated on var.agentcore_enabled (default false → no-op).

variable "agentcore_enabled" {
  type        = bool
  description = "Provision the AgentCore skeleton (ECR/IAM/Lambda/SSM). Written by `make configure`."
  default     = false
}

variable "integrations_enabled" {
  type        = bool
  description = "ADR-039 P2-infra inc2: grant the AgentCore runtime scoped Secrets Manager + KMS for egress integration credentials. Requires agentcore_enabled. Default false → no-op ($0, plan = No changes). PERSIST in live terraform.tfvars so a later full apply does not destroy these."
  default     = false
}

variable "opensearch_vpc_enabled" {
  type        = bool
  description = "Attach the opensearch-mcp Lambda to the private subnets so it can reach a VPC-only OpenSearch domain. Requires agentcore_enabled. Default false → no-op ($0); off = non-VPC (reaches public-endpoint + IAM domains via sigv4). PERSIST in live terraform.tfvars."
  default     = false
}

variable "clickhouse_vpc_enabled" {
  type        = bool
  description = "Attach the clickhouse-mcp Lambda to the private subnets so it can reach an in-VPC ClickHouse endpoint. Requires agentcore_enabled + integrations_enabled. Default false → no-op ($0); off = non-VPC (reaches a public-auth endpoint). PERSIST in live terraform.tfvars."
  default     = false
}

variable "prometheus_vpc_enabled" {
  type        = bool
  description = "Attach the prometheus-mcp Lambda to the private subnets so it can reach an in-cluster Prometheus endpoint. Requires agentcore_enabled + integrations_enabled. Default false → no-op ($0); off = non-VPC. PERSIST in live terraform.tfvars."
  default     = false
}

variable "loki_vpc_enabled" {
  type        = bool
  description = "Attach the loki-mcp Lambda to the private subnets so it can reach an in-cluster Loki endpoint. Requires agentcore_enabled + integrations_enabled. Default false → no-op ($0); off = non-VPC. PERSIST in live terraform.tfvars."
  default     = false
}

variable "tempo_vpc_enabled" {
  type        = bool
  description = "Attach the tempo-mcp Lambda to the private subnets so it can reach an in-cluster Tempo endpoint. Requires agentcore_enabled + integrations_enabled. Default false → no-op ($0); off = non-VPC. PERSIST in live terraform.tfvars."
  default     = false
}

variable "mimir_vpc_enabled" {
  type        = bool
  description = "Attach the mimir-mcp Lambda to the private subnets so it can reach an in-cluster Mimir endpoint. Requires agentcore_enabled + integrations_enabled. Default false → no-op ($0); off = non-VPC. PERSIST in live terraform.tfvars."
  default     = false
}

variable "istio_vpc_enabled" {
  type        = bool
  description = "Attach the istio-read Lambda to the private subnets so it can reach a PRIVATE-ONLY EKS API endpoint. Requires agentcore_enabled. Default false → no-op ($0); off = non-VPC (reaches a public/public+private cluster endpoint). PERSIST in live terraform.tfvars."
  default     = false
}

# ADR-017 — curated official-vendor MCP presets registered as external-obs `mcpServer` gateway
# targets (scripts/v2/agentcore/provision.py), replacing the hand-written Lambda for kinds that
# ship a vendor-official MCP server (Datadog/ClickHouse/Tempo/Jaeger/Grafana/Dynatrace/Splunk/...).
# Requires agentcore_enabled + integrations_enabled. Default false → no-op ($0, plan = No changes).
variable "official_mcp_enabled" {
  type        = bool
  description = "Register curated official-vendor MCP servers (ADR-017) as external-obs gateway mcpServer targets. Requires agentcore_enabled + integrations_enabled. Default false → no-op ($0)."
  default     = false
}

# preset_key (matches scripts/v2/agentcore/catalog.py MCP_SERVER_TARGETS) -> https endpoint. Only
# presets with an entry here are provisioned; the rest SKIP (same convention as agent_lambdas +
# missing lambda_arn). Deployment-specific — set in terraform.tfvars, not hardcoded here.
variable "official_mcp_endpoints" {
  type        = map(string)
  description = "preset_key -> MCP server https endpoint (ADR-017). Deployment-specific; unset presets SKIP. e.g. { datadog = \"https://mcp.datadoghq.com/v1/mcp\" }."
  default     = {}
  # kiro review MAJOR finding, 2026-07-31: without this, an http:// typo would send the bearer
  # token in plaintext, and an arbitrary URL is a de facto BYO-MCP / SSRF-adjacent escape hatch.
  # provision.py additionally re-checks scheme (belt-and-suspenders, since a tfvars change doesn't
  # require a plan/apply of THIS validation to take effect on an existing endpoint value).
  validation {
    condition     = alltrue([for v in values(var.official_mcp_endpoints) : can(regex("^https://", v))])
    error_message = "every official_mcp_endpoints value must be an https:// URL (ADR-017 presets carry a bearer/API-key credential — plaintext http would leak it)."
  }
}

# ADR-017 CRITICAL gate (kiro review, 2026-07-31): provision.py has no server-side tool allowlist
# for mcpServer targets (unlike the Lambda targets' toolSchema.inlinePayload) — it exposes 100% of
# whatever the vendor's remote MCP server advertises. Each preset's read_only_note
# (scripts/v2/agentcore/catalog.py MCP_SERVER_TARGETS) describes a VENDOR-SIDE control (RBAC scope,
# --disable-write, etc) that provision.py cannot verify from the control plane. This var is the
# explicit, per-preset, dated operator acknowledgment that the vendor-side control was actually
# checked before flipping it on — default {} means NOTHING provisions (fail-closed).
#
# type = map(string), NOT map(bool) (round-3 review MAJOR, 2026-07-31 fix): a bare bool acks the
# preset_key forever, independent of WHICH endpoint was reviewed — an operator could ack once, then
# later repoint official_mcp_endpoints[preset_key] at any other URL without re-acking, silently
# sending the stored mcp:<preset_key> credential to an unreviewed endpoint. The ack value must be
# the exact endpoint string that was reviewed; provision.py treats the preset as un-acked (fail-
# closed, same as never-acked) whenever the current official_mcp_endpoints[preset_key] value
# differs from the acked string — so changing the endpoint requires a matching re-ack.
# Self-hosted ADR-017 presets (ClickHouse/Grafana/Splunk/Tempo/Jaeger) have no vendor domain to pin
# against, so catalog.py marks them host_is_operator_asserted. That alone still let a preset key be
# bound to ANY host — the credential would then be handed to it, which is the BYO-MCP connection
# BASELINE §2 pins as do-not-revive. These presets are in-VPC by design, so declare the internal
# domain suffix(es) they may live under ONCE per deployment and the provisioner confines them there.
# A literal RFC1918/ULA address is accepted without a suffix (in-VPC by definition). Default [] means
# self-hosted presets cannot be enabled at all — enabling one is a deliberate, reviewable declaration
# rather than a free-form URL. Vendor-hosted presets ignore this: they use catalog allowed_host_suffixes.
variable "official_mcp_self_hosted_host_suffixes" {
  type        = list(string)
  description = "Internal domain suffixes the self-hosted ADR-017 presets may be reached at, e.g. [\".internal\", \".svc.cluster.local\"] (ADR-017). A literal private (RFC1918/ULA) address is allowed without a suffix. Default [] = self-hosted presets fail closed."
  default     = []
  validation {
    condition     = alltrue([for v in var.official_mcp_self_hosted_host_suffixes : startswith(v, ".")])
    error_message = "every suffix must start with '.' so it can only match on a DNS label boundary (e.g. \".internal\" — \"internal\" would also match \"evil-internal\")."
  }
}

variable "official_mcp_read_only_ack" {
  type        = map(string)
  description = "preset_key -> the exact official_mcp_endpoints[preset_key] URL the operator reviewed and verified the read-only vendor-side control (catalog.py read_only_note) against (ADR-017). Must equal the CURRENT endpoint value or the preset is treated as un-acked (fail-closed, retires any live target) — changing the endpoint requires re-acking with the new URL. Default {} = nothing provisions."
  default     = {}
}

locals {
  ac_count           = var.agentcore_enabled ? 1 : 0
  integ_count        = var.agentcore_enabled && var.integrations_enabled ? 1 : 0
  official_mcp_count = var.official_mcp_enabled && local.integ_count > 0 ? 1 : 0
  # AgentCore runtime name — a FIXED product-level constant (like v1's `awsops_agent`), NOT
  # project-derived. MUST stay in sync with RUNTIME_NAME in scripts/v2/agentcore/provision.py
  # ("awsops_v2_agent"); the provisioner appends a control-plane-generated `-<id>` suffix. IAM
  # resource ARNs that scope runtime invoke must match THIS name — deriving it from var.project
  # (e.g. "awsops_v2_stg_agent") produces an ARN that never matches the real runtime, so the web
  # task role gets AccessDenied on bedrock-agentcore:InvokeAgentRuntime and chat fails.
  agent_runtime_name = "awsops_v2_agent"
}

# ---- dual-tier ECR for the agent runtime image (mirrors ecr.tf) ----
resource "aws_ecr_repository" "agentcore" {
  count                = local.ac_count
  name                 = "${var.project}-agentcore"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true
}

resource "aws_ecrpublic_repository" "agentcore" {
  count           = local.ac_count
  provider        = aws.use1
  repository_name = "${var.project}-agentcore"
  catalog_data {
    about_text    = "AWSops v2 AgentCore runtime (Strands agent on AgentCore Runtime)."
    architectures = ["ARM 64"]
    description   = "AWSops v2 AgentCore agent image."
  }
}

# ---- AgentCore role: used by BOTH the Runtime (model invoke + gateway calls) and the
#      Gateways (GATEWAY_IAM_ROLE → invoke target Lambdas). Least-privilege per 3-AI Finding 6. ----
data "aws_iam_policy_document" "agentcore_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com", "bedrock-agentcore.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "agentcore" {
  count              = local.ac_count
  name               = "${var.project}-agentcore"
  assume_role_policy = data.aws_iam_policy_document.agentcore_assume.json
}

resource "aws_iam_role_policy" "agentcore" {
  count = local.ac_count
  name  = "${var.project}-agentcore-perms"
  role  = aws_iam_role.agentcore[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BedrockModelInvoke"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      {
        Sid      = "AgentCoreControlAndData"
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:*"]
        Resource = "*"
      },
      {
        Sid      = "InvokeAgentLambdasOnly"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${var.project}-agent-*"
      },
      {
        # Runtime pulls its container image from the private ECR repo via this role.
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid      = "EcrPullAgentImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.agentcore[0].arn
      },
      {
        Sid      = "RuntimeLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*"
      }
    ]
  })
}

# ---- ADR-039 P2-infra inc2: egress integrations — dedicated CMK + scoped runtime grant ----
# Integration credentials (API keys / OAuth tokens) live in Secrets Manager under
# ops/${project}/integrations/* encrypted with THIS dedicated key (isolated from the Aurora CMK).
# All count-gated on integrations_enabled (default false → $0, plan = No changes). The agent.py
# runtime (assumed-by bedrock-agentcore) reads them at request time by credentials_ref ARN.
resource "aws_kms_key" "integrations" {
  count                   = local.integ_count
  description             = "${var.project} egress integration credential encryption (ADR-039)"
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "integrations" {
  count         = local.integ_count
  name          = "alias/${var.project}-integrations"
  target_key_id = aws_kms_key.integrations[0].key_id
}

# SEPARATE policy (NOT folded into aws_iam_role_policy.agentcore) so a targeted apply is purely
# additive — 0 change to the existing runtime policy. secretsmanager:GetSecretValue is scoped to the
# integrations secret NAMESPACE (the random 6-char ARN suffix means a name-prefix wildcard is the
# correct Secrets Manager scoping — this is NOT an action/resource "*"); kms:Decrypt is scoped to the
# dedicated key only. NOTE: a sigv4 integration to a specific AWS service (e.g. execute-api:Invoke)
# needs a per-target grant added when that integration is registered — DEFERRED with Q3-sigv4=C.
resource "aws_iam_role_policy" "agentcore_integrations" {
  count = local.integ_count
  name  = "${var.project}-agentcore-integrations"
  role  = aws_iam_role.agentcore[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "IntegrationSecretsRead"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:ops/${var.project}/integrations/*"
      },
      {
        Sid      = "IntegrationSecretsKmsDecrypt"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.integrations[0].arn
      }
    ]
  })
}

# ---- Single integrations credentials secret (DevOps-agent-style credential-write UX).
# ONE secret holds a JSON map keyed by integration slug (=kind): {"notion":{"token":...}, ...}.
# The web BFF writes it (PutSecretValue, admin UI); connector Lambdas read map[INTEGRATION_SLUG].
# DEFAULT aws/secretsmanager key (no custom CMK) → GetSecretValue/PutSecretValue need no
# kms:Decrypt. TF owns existence only — the VALUE is BFF-managed (no secret_version, no
# ignore_changes). Clean replacement of the never-deployed per-notion secret. ----
resource "aws_secretsmanager_secret" "integrations" {
  count                   = local.integ_count
  name                    = "ops/${var.project}/integrations/credentials"
  description             = "Integration credentials map (slug-keyed JSON) for read-tier connectors. Values written by the admin UI."
  recovery_window_in_days = 7
}

# Scoped grant on the agent Lambda EXEC role (not the agentcore runtime role) — the role the
# connector Lambdas run under. GetSecretValue on the exact single secret ARN only.
resource "aws_iam_role_policy" "agent_lambda_integrations_secret" {
  count = local.integ_count
  name  = "${var.project}-agent-lambda-integrations-secret"
  role  = aws_iam_role.agent_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "IntegrationsSecretRead"
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_secretsmanager_secret.integrations[0].arn
    }]
  })
}

# inventory-read MCP (inventory_read_mcp.py) — reads the synced Aurora inventory via the RDS Data
# API (read-only SELECT). Scoped to ExecuteStatement on the cluster + GetSecretValue on the
# RDS-managed master secret + Decrypt on the secret's CMK. Additive (own resource) so a targeted
# apply leaves the runtime policy untouched.
resource "aws_iam_role_policy" "agent_lambda_inventory" {
  count = local.ac_count
  name  = "${var.project}-agent-lambda-inventory"
  role  = aws_iam_role.agent_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AuroraDataApiRead"
        Effect   = "Allow"
        Action   = ["rds-data:ExecuteStatement"]
        Resource = aws_rds_cluster.aurora.arn
      },
      {
        Sid      = "AuroraMasterSecretRead"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      },
      {
        Sid      = "AuroraSecretKmsDecrypt"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = aws_kms_key.aurora.arn
      },
    ]
  })
}

# OpenSearch read connector (opensearch_mcp.py) — AWS-native, read-only. NOTE: Amazon OpenSearch
# *managed* domains use the es: IAM prefix (NOT opensearch:, which is Serverless/aoss:). Scoped to
# HTTP read verbs on domain ARNs + list/describe for endpoint resolution.
resource "aws_iam_role_policy" "agent_lambda_opensearch" {
  count = local.ac_count
  name  = "${var.project}-agent-lambda-opensearch"
  role  = aws_iam_role.agent_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "OpenSearchHttpRead"
        Effect   = "Allow"
        Action   = ["es:ESHttpGet", "es:ESHttpPost"]
        Resource = "arn:aws:es:${var.region}:${data.aws_caller_identity.current.account_id}:domain/*/*"
      },
      {
        Sid      = "OpenSearchDescribe"
        Effect   = "Allow"
        Action   = ["es:ListDomainNames", "es:DescribeDomain", "es:DescribeDomains"]
        Resource = "*"
      },
    ]
  })
}

# ENI perms for the opensearch-mcp Lambda ONLY when it is VPC-attached (opensearch_vpc_enabled).
# Compound-gated: references agent_lambda[0], which exists only when agentcore_enabled → guard both.
resource "aws_iam_role_policy" "agent_lambda_vpc_eni" {
  count = var.agentcore_enabled && (var.opensearch_vpc_enabled || var.clickhouse_vpc_enabled || var.prometheus_vpc_enabled || var.loki_vpc_enabled || var.tempo_vpc_enabled || var.mimir_vpc_enabled || var.istio_vpc_enabled) ? 1 : 0
  name  = "${var.project}-agent-lambda-vpc-eni"
  role  = aws_iam_role.agent_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "LambdaVpcEni"
      Effect   = "Allow"
      Action   = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface"]
      Resource = "*"
    }]
  })
}

# ---- SSM String params (placeholders; provision.py overwrites the value). Not secrets → String. ----
resource "aws_ssm_parameter" "agentcore_runtime_arn" {
  count     = local.ac_count
  name      = "/ops/${var.project}/agentcore/runtime_arn"
  type      = "String"
  value     = "PENDING"
  overwrite = true
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "agentcore_interpreter_id" {
  count     = local.ac_count
  name      = "/ops/${var.project}/agentcore/interpreter_id"
  type      = "String"
  value     = "PENDING"
  overwrite = true
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "agentcore_memory_id" {
  count     = local.ac_count
  name      = "/ops/${var.project}/agentcore/memory_id"
  type      = "String"
  value     = "PENDING"
  overwrite = true
  lifecycle {
    ignore_changes = [value]
  }
}

# ---- web task role reads the AgentCore SSM params at runtime (P3 consumer). TASK role, NOT
#      execution role → avoids the valueFrom-at-task-start race (3-AI Q3 / P1d blocker). ----
resource "aws_iam_role_policy" "task_agentcore_ssm" {
  count = local.ac_count
  name  = "${var.project}-task-agentcore-ssm"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/ops/${var.project}/agentcore/*"
    }]
  })
}

# v1-parity AgentCore console (web/app/agentcore + web/lib/agentcore-status.ts): read-only
# control-plane status (runtime/gateways/targets/memory/interpreter). These List*/Get* control
# actions have no resource-level scoping in AgentCore → "*", read-only by construction.
resource "aws_iam_role_policy" "task_agentcore_status" {
  count = local.ac_count
  name  = "${var.project}-task-agentcore-status"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock-agentcore:GetAgentRuntime",
        "bedrock-agentcore:ListAgentRuntimeEndpoints",
        "bedrock-agentcore:ListGateways",
        "bedrock-agentcore:ListGatewayTargets",
        "bedrock-agentcore:ListMemories",
        "bedrock-agentcore:ListCodeInterpreters",
      ]
      Resource = "*"
    }]
  })
}

# v1-parity Code Interpreter chat route (web/lib/code-interpreter.ts): the web task role runs Python
# in the provisioned AgentCore sandbox (Start/Invoke/Stop/Get session). Data-plane only — NOT the
# control-plane create/delete. Scoped to this account/region's code-interpreter resources. The
# Sonnet code-GENERATION + Bedrock-direct fallback InvokeModelWithResponseStream is already granted
# by task_synthesis_bedrock (same Sonnet FM/profile); this policy adds only the sandbox actions.
resource "aws_iam_role_policy" "task_code_interpreter" {
  count = local.ac_count
  name  = "${var.project}-task-code-interpreter"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock-agentcore:StartCodeInterpreterSession",
        "bedrock-agentcore:InvokeCodeInterpreter",
        "bedrock-agentcore:StopCodeInterpreterSession",
        "bedrock-agentcore:GetCodeInterpreterSession",
      ]
      Resource = [
        "arn:aws:bedrock-agentcore:${var.region}:${data.aws_caller_identity.current.account_id}:code-interpreter-custom/*",
        "arn:aws:bedrock-agentcore:${var.region}:${data.aws_caller_identity.current.account_id}:code-interpreter/*",
      ]
    }]
  })
}

# web task role may invoke the AgentCore runtime (P3-A chat). Scoped to our runtime name prefix
# (the runtime ID suffix is provisioner-generated) + its DEFAULT endpoint. No wildcard actions.
resource "aws_iam_role_policy" "task_agentcore_invoke" {
  count = local.ac_count
  name  = "${var.project}-task-agentcore-invoke"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock-agentcore:InvokeAgentRuntime"]
      Resource = [
        "arn:aws:bedrock-agentcore:${var.region}:${data.aws_caller_identity.current.account_id}:runtime/${local.agent_runtime_name}-*",
        "arn:aws:bedrock-agentcore:${var.region}:${data.aws_caller_identity.current.account_id}:runtime/${local.agent_runtime_name}-*/runtime-endpoint/*"
      ]
    }]
  })
}

# web task role reads Cost Explorer for the Cost page / Overview (P3-B). CE has no resource-level
# scoping → "*". Read-only (GetCostAndUsage/GetCostForecast).
resource "aws_iam_role_policy" "task_cost" {
  count = local.ac_count
  name  = "${var.project}-task-cost-read"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ce:GetCostAndUsage", "ce:GetCostForecast"]
      Resource = "*"
    }]
  })
}

data "aws_caller_identity" "current" {}

# ---- agent Lambda execution role (read-only invariant; reachability/write ops excluded) ----
data "aws_iam_policy_document" "agent_lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "agent_lambda" {
  count              = local.ac_count
  name               = "${var.project}-agent-lambda"
  assume_role_policy = data.aws_iam_policy_document.agent_lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_lambda_logs" {
  count      = local.ac_count
  role       = aws_iam_role.agent_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "agent_lambda_read" {
  count = local.ac_count
  name  = "${var.project}-agent-lambda-read"
  role  = aws_iam_role.agent_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Existing slice (iam-mcp / flow-monitor). ec2:Describe* also serves network-mcp.
        Sid      = "ReadOnlySlice"
        Effect   = "Allow"
        Action   = ["iam:Get*", "iam:List*", "iam:SimulatePrincipalPolicy", "ec2:Describe*"]
        Resource = "*"
      },
      {
        # network-mcp (ELB + Network Firewall; ec2:Describe* above covers VPC/TGW/VPN/ENI/FlowLogs).
        Sid    = "NetworkRead"
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:Describe*",
          "network-firewall:Describe*",
          "network-firewall:List*"
        ]
        Resource = "*"
      },
      {
        # container: eks-mcp (control-plane) + ecs-mcp (ECS + ECR).
        Sid    = "ContainerRead"
        Effect = "Allow"
        Action = [
          "eks:Describe*",
          "eks:List*",
          "ecs:Describe*",
          "ecs:List*",
          "ecr:Describe*",
          "ecr:List*",
          "ecr:BatchGet*"
        ]
        Resource = "*"
      },
      {
        # data: rds (describe; execute_sql via Data API not granted → SELECT errors gracefully),
        #       dynamodb (describe + read items), valkey (elasticache), msk (kafka).
        Sid    = "DataRead"
        Effect = "Allow"
        Action = [
          "rds:Describe*",
          "rds:ListTagsForResource",
          "dynamodb:Describe*",
          "dynamodb:List*",
          "dynamodb:Query",
          "dynamodb:GetItem",
          "dynamodb:Scan",
          "elasticache:Describe*",
          "kafka:Describe*",
          "kafka:List*",
          "kafka:Get*"
        ]
        Resource = "*"
      },
      {
        # cost: cost-mcp (Cost Explorer + Pricing + Budgets) + finops-mcp (Compute Optimizer +
        #       Savings Plans + Trusted Advisor via support).
        Sid    = "CostRead"
        Effect = "Allow"
        Action = [
          "ce:Get*",
          "ce:List*",
          "ce:Describe*",
          "pricing:GetProducts",
          "pricing:DescribeServices",
          "budgets:Describe*",
          "budgets:View*",
          "compute-optimizer:Get*",
          "savingsplans:Describe*",
          "support:Describe*"
        ]
        Resource = "*"
      },
      {
        # monitoring: cloudwatch-mcp (metrics + Logs Insights) + cloudtrail-mcp (Lake; StartQuery = read).
        Sid    = "MonitoringRead"
        Effect = "Allow"
        Action = [
          "cloudwatch:Get*",
          "cloudwatch:List*",
          "cloudwatch:Describe*",
          "logs:Describe*",
          "logs:Get*",
          "logs:FilterLogEvents",
          "logs:StartQuery",
          "logs:StopQuery",
          "cloudtrail:LookupEvents",
          "cloudtrail:Describe*",
          "cloudtrail:Get*",
          "cloudtrail:List*",
          "cloudtrail:StartQuery"
        ]
        Resource = "*"
      },
      {
        # iac: iac-mcp (CloudFormation). terraform-mcp / aws-knowledge need no AWS IAM (public HTTPS).
        Sid    = "IacRead"
        Effect = "Allow"
        Action = [
          "cloudformation:Describe*",
          "cloudformation:Detect*",
          "cloudformation:Get*",
          "cloudformation:List*",
          "cloudformation:ValidateTemplate"
        ]
        Resource = "*"
      },
      {
        Sid      = "CrossAccountAssumeReadOnly"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = "arn:aws:iam::*:role/AWSopsReadOnlyRole"
      }
    ]
  })
}

# The slice. key → source file (handler is "<module>.lambda_handler"). cross_account.py is bundled.
locals {
  # AWS MCP slice gated on agentcore_enabled; the Notion external-integration connector
  # is gated on integrations_enabled (one unit with its secret + IAM below). integ_count
  # requires agentcore_enabled, so aws_iam_role.agent_lambda[0] is always present here.
  agent_lambdas = merge(var.agentcore_enabled ? {
    "iam-mcp"      = { file = "aws_iam_mcp.py", handler = "aws_iam_mcp.lambda_handler" }
    "flow-monitor" = { file = "flowmonitor.py", handler = "flowmonitor.lambda_handler" }
    # Read-only MCP additions (2026-06-18) — static helpers + computed reachability + istio-read.
    "core-helpers"      = { file = "core_helpers_mcp.py", handler = "core_helpers_mcp.lambda_handler" }
    "reachability-read" = { file = "reachability_read_mcp.py", handler = "reachability_read_mcp.lambda_handler" }
    "istio-read"        = { file = "istio_read_mcp.py", handler = "istio_read_mcp.lambda_handler" }
    "network-mcp"       = { file = "network_mcp.py", handler = "network_mcp.lambda_handler" }
    "eks-mcp"           = { file = "aws_eks_mcp.py", handler = "aws_eks_mcp.lambda_handler" }
    "ecs-mcp"           = { file = "aws_ecs_mcp.py", handler = "aws_ecs_mcp.lambda_handler" }
    "rds-mcp"           = { file = "aws_rds_mcp.py", handler = "aws_rds_mcp.lambda_handler" }
    "dynamodb-mcp"      = { file = "aws_dynamodb_mcp.py", handler = "aws_dynamodb_mcp.lambda_handler" }
    "msk-mcp"           = { file = "aws_msk_mcp.py", handler = "aws_msk_mcp.lambda_handler" }
    "valkey-mcp"        = { file = "aws_valkey_mcp.py", handler = "aws_valkey_mcp.lambda_handler" }
    "cost-mcp"          = { file = "aws_cost_mcp.py", handler = "aws_cost_mcp.lambda_handler" }
    "finops-mcp"        = { file = "aws_finops_mcp.py", handler = "aws_finops_mcp.lambda_handler" }
    "cloudwatch-mcp"    = { file = "aws_cloudwatch_mcp.py", handler = "aws_cloudwatch_mcp.lambda_handler" }
    "cloudtrail-mcp"    = { file = "aws_cloudtrail_mcp.py", handler = "aws_cloudtrail_mcp.lambda_handler" }
    "iac-mcp"           = { file = "aws_iac_mcp.py", handler = "aws_iac_mcp.lambda_handler" }
    "terraform-mcp"     = { file = "aws_terraform_mcp.py", handler = "aws_terraform_mcp.lambda_handler" }
    "aws-knowledge"     = { file = "aws_knowledge.py", handler = "aws_knowledge.lambda_handler" }
    "opensearch-mcp"    = { file = "opensearch_mcp.py", handler = "opensearch_mcp.lambda_handler" }
    # ops inventory_read: reads the synced Aurora topology/inventory via the RDS Data API (read-only)
    "inventory-read" = { file = "inventory_read_mcp.py", handler = "inventory_read_mcp.lambda_handler" }
    } : {}, local.integ_count > 0 ? {
    "notion-mcp"     = { file = "notion_mcp.py", handler = "notion_mcp.lambda_handler" }
    "clickhouse-mcp" = { file = "clickhouse_mcp.py", handler = "clickhouse_mcp.lambda_handler" }
    "prometheus-mcp" = { file = "prometheus_mcp.py", handler = "prometheus_mcp.lambda_handler" }
    "loki-mcp"       = { file = "loki_mcp.py", handler = "loki_mcp.lambda_handler" }
    "tempo-mcp"      = { file = "tempo_mcp.py", handler = "tempo_mcp.lambda_handler" }
    "mimir-mcp"      = { file = "mimir_mcp.py", handler = "mimir_mcp.lambda_handler" }
    # v1 datasource-family completion (2026-07-21): trace search / SaaS metric platforms.
    "jaeger-mcp"    = { file = "jaeger_mcp.py", handler = "jaeger_mcp.lambda_handler" }
    "dynatrace-mcp" = { file = "dynatrace_mcp.py", handler = "dynatrace_mcp.lambda_handler" }
    "datadog-mcp"   = { file = "datadog_mcp.py", handler = "datadog_mcp.lambda_handler" }
  } : {})
}

data "archive_file" "agent" {
  for_each    = local.agent_lambdas
  type        = "zip"
  output_path = "${path.module}/.build/agent-${each.key}.zip"
  source {
    content  = file("${path.module}/../../../agent/lambda/${each.value.file}")
    filename = each.value.file
  }
  source {
    content  = file("${path.module}/../../../agent/lambda/cross_account.py")
    filename = "cross_account.py"
  }
  # The datasource-family connectors (clickhouse/prometheus/loki/tempo/mimir) import the shared
  # `datasource_http` helper (credential load, SSRF host guard, auth headers, no-redirect HTTP, inline
  # conn-config + health probe). Bundle it into ONLY those ZIPs — without it the Lambda dies at import
  # time (Runtime.ImportModuleError: No module named 'datasource_http').
  dynamic "source" {
    for_each = contains(["clickhouse_mcp.py", "prometheus_mcp.py", "loki_mcp.py", "tempo_mcp.py", "mimir_mcp.py", "jaeger_mcp.py", "dynatrace_mcp.py", "datadog_mcp.py"], each.value.file) ? [1] : []
    content {
      content  = file("${path.module}/../../../agent/lambda/datasource_http.py")
      filename = "datasource_http.py"
    }
  }
}

resource "aws_lambda_function" "agent" {
  for_each         = local.agent_lambdas
  function_name    = "${var.project}-agent-${each.key}"
  role             = aws_iam_role.agent_lambda[0].arn
  runtime          = "python3.11"
  handler          = each.value.handler
  filename         = data.archive_file.agent[each.key].output_path
  source_code_hash = data.archive_file.agent[each.key].output_base64sha256
  timeout          = 60
  memory_size      = 256
  architectures    = ["arm64"]

  environment {
    variables = merge({
      # Same-account access uses the Lambda's own execution role; AssumeRole is
      # only for *other* onboarded accounts. Lets cross_account.get_role_arn skip
      # a self-assume of AWSopsReadOnlyRole (which exists only in target accounts,
      # never the host) — otherwise host-account tool calls fail with AccessDenied.
      AWSOPS_HOST_ACCOUNT_ID = data.aws_caller_identity.current.account_id
      },
      # Connectors that read the single integrations secret get its exact TF-created name (no drift
      # from the Python default). notion-mcp also pins INTEGRATION_SLUG; clickhouse-mcp uses a fixed
      # SLUG in code. Both exist only when integ_count>0 so integrations[0] is safe.
      contains(["notion-mcp", "clickhouse-mcp", "prometheus-mcp", "loki-mcp", "tempo-mcp", "mimir-mcp", "jaeger-mcp", "dynatrace-mcp", "datadog-mcp"], each.key) ? merge(
        { INTEGRATIONS_SECRET_NAME = aws_secretsmanager_secret.integrations[0].name },
        each.key == "notion-mcp" ? { INTEGRATION_SLUG = "notion" } : {}
      ) : {},
      # inventory-read reads the synced Aurora inventory via the RDS Data API (no VPC, no pg8000) —
      # needs the cluster ARN, the RDS-managed master secret ARN, and the DB name.
      each.key == "inventory-read" ? {
        AURORA_CLUSTER_ARN = aws_rds_cluster.aurora.arn
        AURORA_SECRET_ARN  = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
        AURORA_DATABASE    = aws_rds_cluster.aurora.database_name
      } : {}
    )
  }

  # Per-Lambda VPC opt-in: attach a connector to the private subnets ONLY when its <name>_vpc_enabled
  # flag is set (opensearch/clickhouse/prometheus/loki/tempo/mimir for VPC-only datasources;
  # istio-read for a private-only EKS API endpoint). Off (default) → no vpc_config → non-VPC.
  dynamic "vpc_config" {
    for_each = ((each.key == "opensearch-mcp" && var.opensearch_vpc_enabled) || (each.key == "clickhouse-mcp" && var.clickhouse_vpc_enabled) || (each.key == "prometheus-mcp" && var.prometheus_vpc_enabled) || (each.key == "loki-mcp" && var.loki_vpc_enabled) || (each.key == "tempo-mcp" && var.tempo_vpc_enabled) || (each.key == "mimir-mcp" && var.mimir_vpc_enabled) || (each.key == "istio-read" && var.istio_vpc_enabled)) ? [1] : []
    content {
      subnet_ids         = local.private_subnet_ids
      security_group_ids = [aws_security_group.service.id]
    }
  }
}

# Allow the AgentCore Gateway (via its IAM role) to invoke each agent Lambda.
resource "aws_lambda_permission" "agent_agentcore" {
  for_each      = local.agent_lambdas
  statement_id  = "AllowAgentCoreInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent[each.key].function_name
  principal     = "bedrock-agentcore.amazonaws.com"
  # Confused-deputy guard: only AgentCore gateways in THIS account may invoke.
  source_account = data.aws_caller_identity.current.account_id
}

# ---- outputs consumed by scripts/v2/agentcore/provision.py ----
output "agentcore" {
  description = "AgentCore provisioning inputs for scripts/v2/agentcore/provision.py (null when disabled)."
  value = var.agentcore_enabled ? {
    region             = var.region
    project            = var.project
    role_arn           = aws_iam_role.agentcore[0].arn
    ecr_uri            = aws_ecr_repository.agentcore[0].repository_url
    lambda_arns        = { for k, fn in aws_lambda_function.agent : k => fn.arn }
    ssm_runtime_arn    = aws_ssm_parameter.agentcore_runtime_arn[0].name
    ssm_interpreter_id = aws_ssm_parameter.agentcore_interpreter_id[0].name
    ssm_memory_id      = aws_ssm_parameter.agentcore_memory_id[0].name
    # ADR-017 — curated official-MCP preset endpoints (empty map when official_mcp_enabled=false).
    # provision.py SKIPs any catalog.MCP_SERVER_TARGETS preset whose key is missing here.
    official_mcp_endpoints = local.official_mcp_count > 0 ? var.official_mcp_endpoints : {}
    # ADR-017 CRITICAL gate — map(string), NOT bools: the value must be the EXACT
    # official_mcp_endpoints[preset_key] URL the operator reviewed. provision.py refuses to
    # provision (and retires any live target for) every preset whose ack is missing or != the
    # current endpoint, regardless of credential. See var.official_mcp_read_only_ack above.
    official_mcp_read_only_ack = local.official_mcp_count > 0 ? var.official_mcp_read_only_ack : {}
    # Confines the self-hosted (host_is_operator_asserted) presets — see the variable above.
    official_mcp_self_hosted_host_suffixes = local.official_mcp_count > 0 ? var.official_mcp_self_hosted_host_suffixes : []
    # Same secret the web BFF writes preset credentials into (web/lib/integration-credentials.ts,
    # namespaced key = "mcp:<preset_key>", e.g. secret["mcp:datadog"] — NOT the plain preset_key,
    # which is a separate legacy datasource-connector kind-mirror) — provision.py reads the
    # namespaced key to create/refresh each preset's AgentCore Identity API-key credential
    # provider. null when integrations_enabled=false.
    integrations_secret_name = local.integ_count > 0 ? aws_secretsmanager_secret.integrations[0].name : null
    # Runtime VPC mode (Pattern 2): ENIs in our private subnets (apne2-az1/az2, AgentCore-supported)
    # so section agents can reach private resources (Aurora/EKS) directly. Reuse the service SG —
    # the Aurora SG already allows it (C8), and its egress→NAT lets the runtime still reach
    # Bedrock/AgentCore/ECR. provision.py emits networkMode=VPC when these are present.
    subnets         = local.private_subnet_ids
    security_groups = [aws_security_group.service.id]
  } : null
}
