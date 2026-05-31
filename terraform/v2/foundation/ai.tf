# AWSops v2 — P1f AgentCore provisioner (Terraform-native parts).
# AgentCore control-plane resources (Runtime/Gateway/Target/Memory/Interpreter) are NOT
# Terraform-native — they are created by scripts/v2/agentcore/provision.py after apply.
# Everything here is gated on var.agentcore_enabled (default false → no-op).

variable "agentcore_enabled" {
  type        = bool
  description = "Provision the AgentCore skeleton (ECR/IAM/Lambda/SSM). Written by `make configure`."
  default     = false
}

locals {
  ac_count = var.agentcore_enabled ? 1 : 0
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
      }
    ]
  })
}

# ---- SSM String params (placeholders; provision.py overwrites the value). Not secrets → String. ----
resource "aws_ssm_parameter" "agentcore_runtime_arn" {
  count     = local.ac_count
  name      = "/${var.project}/agentcore/runtime_arn"
  type      = "String"
  value     = "PENDING"
  overwrite = true
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "agentcore_interpreter_id" {
  count     = local.ac_count
  name      = "/${var.project}/agentcore/interpreter_id"
  type      = "String"
  value     = "PENDING"
  overwrite = true
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "agentcore_memory_id" {
  count     = local.ac_count
  name      = "/${var.project}/agentcore/memory_id"
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
      Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project}/agentcore/*"
    }]
  })
}

data "aws_caller_identity" "current" {}
