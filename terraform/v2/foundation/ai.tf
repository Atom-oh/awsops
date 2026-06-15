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

locals {
  ac_count    = var.agentcore_enabled ? 1 : 0
  integ_count = var.agentcore_enabled && var.integrations_enabled ? 1 : 0
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
        "arn:aws:bedrock-agentcore:${var.region}:${data.aws_caller_identity.current.account_id}:runtime/${replace(var.project, "-", "_")}_agent-*",
        "arn:aws:bedrock-agentcore:${var.region}:${data.aws_caller_identity.current.account_id}:runtime/${replace(var.project, "-", "_")}_agent-*/runtime-endpoint/*"
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
    "iam-mcp"        = { file = "aws_iam_mcp.py", handler = "aws_iam_mcp.lambda_handler" }
    "flow-monitor"   = { file = "flowmonitor.py", handler = "flowmonitor.lambda_handler" }
    "network-mcp"    = { file = "network_mcp.py", handler = "network_mcp.lambda_handler" }
    "eks-mcp"        = { file = "aws_eks_mcp.py", handler = "aws_eks_mcp.lambda_handler" }
    "ecs-mcp"        = { file = "aws_ecs_mcp.py", handler = "aws_ecs_mcp.lambda_handler" }
    "rds-mcp"        = { file = "aws_rds_mcp.py", handler = "aws_rds_mcp.lambda_handler" }
    "dynamodb-mcp"   = { file = "aws_dynamodb_mcp.py", handler = "aws_dynamodb_mcp.lambda_handler" }
    "msk-mcp"        = { file = "aws_msk_mcp.py", handler = "aws_msk_mcp.lambda_handler" }
    "valkey-mcp"     = { file = "aws_valkey_mcp.py", handler = "aws_valkey_mcp.lambda_handler" }
    "cost-mcp"       = { file = "aws_cost_mcp.py", handler = "aws_cost_mcp.lambda_handler" }
    "finops-mcp"     = { file = "aws_finops_mcp.py", handler = "aws_finops_mcp.lambda_handler" }
    "cloudwatch-mcp" = { file = "aws_cloudwatch_mcp.py", handler = "aws_cloudwatch_mcp.lambda_handler" }
    "cloudtrail-mcp" = { file = "aws_cloudtrail_mcp.py", handler = "aws_cloudtrail_mcp.lambda_handler" }
    "iac-mcp"        = { file = "aws_iac_mcp.py", handler = "aws_iac_mcp.lambda_handler" }
    "terraform-mcp"  = { file = "aws_terraform_mcp.py", handler = "aws_terraform_mcp.lambda_handler" }
    "aws-knowledge"  = { file = "aws_knowledge.py", handler = "aws_knowledge.lambda_handler" }
    } : {}, local.integ_count > 0 ? {
    "notion-mcp" = { file = "notion_mcp.py", handler = "notion_mcp.lambda_handler" }
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
      # Pin the Notion Lambda to the exact TF-created secret name (can't drift from the
      # Python default if var.project ever changes). notion-mcp exists only when integ_count>0.
      each.key == "notion-mcp" ? {
        INTEGRATIONS_SECRET_NAME = aws_secretsmanager_secret.integrations[0].name
        INTEGRATION_SLUG         = "notion"
      } : {}
    )
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
    # Runtime VPC mode (Pattern 2): ENIs in our private subnets (apne2-az1/az2, AgentCore-supported)
    # so section agents can reach private resources (Aurora/EKS) directly. Reuse the service SG —
    # the Aurora SG already allows it (C8), and its egress→NAT lets the runtime still reach
    # Bedrock/AgentCore/ECR. provision.py emits networkMode=VPC when these are present.
    subnets         = local.private_subnet_ids
    security_groups = [aws_security_group.service.id]
  } : null
}
