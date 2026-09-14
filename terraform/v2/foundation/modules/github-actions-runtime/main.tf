terraform {
  required_version = ">= 1.15"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

# Authorization resource kinds and supported condition keys:
# https://servicereference.us-east-1.amazonaws.com/v1/bedrock-agentcore/bedrock-agentcore.json
# https://servicereference.us-east-1.amazonaws.com/v1/ecs/ecs.json
# No S3, Terraform backend, raw state, IAM administration or application flag grants.
locals {
  ecs       = "arn:aws:ecs:${var.region}:${var.account_id}"
  ac        = "arn:aws:bedrock-agentcore:${var.region}:${var.account_id}"
  agentname = "${replace(var.project, "-", "_")}_agent"
  cluster   = "${local.ecs}:cluster/${var.project}"
  region    = { StringEquals = { "aws:RequestedRegion" = var.region } }
  create = {
    StringEquals = {
      "aws:RequestedRegion"           = var.region
      "aws:RequestTag/awsops:project" = var.project
    }
    "ForAllValues:StringEquals" = { "aws:TagKeys" = ["awsops:project"] }
  }
  # AgentRuntimeId is name-[A-Za-z0-9]{10}. A trailing * also matches endpoint
  # suffixes, making the DEFAULT entry redundant and widening its ARN scope.
  runtime_id_pattern = "${local.agentname}-??????????"
  runtime = [
    "${local.ac}:runtime/${local.runtime_id_pattern}",
    "${local.ac}:runtime/${local.runtime_id_pattern}/runtime-endpoint/DEFAULT",
  ]
  gateway     = "${local.ac}:gateway/${var.project}-*"
  memory      = "${local.ac}:memory/${replace(var.project, "-", "_")}_memory-*"
  interpreter = "${local.ac}:code-interpreter-custom/${replace(var.project, "-", "_")}_code_interpreter-*"
  credentials = [
    "${local.ac}:token-vault/default",
    "${local.ac}:token-vault/default/apikeycredentialprovider/${var.project}-*-mcp",
  ]
  ecs_role_arns = [
    coalesce(var.worker_task_role_arn, "arn:aws:iam::${var.account_id}:role/${var.project}-worker-task"),
    coalesce(var.execution_role_arn, "arn:aws:iam::${var.account_id}:role/${var.project}-task-execution"),
  ]
  policies = {
    artifacts = jsonencode({
      Version = "2012-10-17"
      Statement = concat([
        {
          Sid      = "EcrLogin", Effect = "Allow", Action = ["ecr:GetAuthorizationToken"],
          Resource = "*", Condition = local.region
        },
        {
          Sid = "RuntimeImages", Effect = "Allow",
          Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"],
          Resource  = [for kind in ["agentcore", "worker", "steampipe"] : "arn:aws:ecr:${var.region}:${var.account_id}:repository/${var.project}-${kind}"],
          Condition = local.region
        },
        {
          Sid       = "MigrationClusterIdentity", Effect = "Allow", Action = ["rds:DescribeDBClusters"],
          Resource  = "arn:aws:rds:${var.region}:${var.account_id}:cluster:${var.project}-aurora",
          Condition = local.region
        },
        ], var.migration_enabled ? [{
          # ECR exposes repository authorization, not an ImageTag condition for
          # PutImage. The protected workflow constrains tags to migration-<sha>.
          Sid = "SharedMigrationImages", Effect = "Allow",
          Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"],
          Resource  = "arn:aws:ecr:${var.region}:${var.account_id}:repository/${var.project}-web",
          Condition = local.region
          }] : [], length(var.secret_arns) == 0 ? [] : [{
          Sid      = "ApprovedSecrets", Effect = "Allow",
          Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
          Resource = var.secret_arns, Condition = local.region
          }], length(var.secret_kms_key_arns) == 0 ? [] : [{
          Sid      = "ApprovedSecretKeys", Effect = "Allow", Action = ["kms:Decrypt"],
          Resource = var.secret_kms_key_arns,
          Condition = { StringEquals = {
            "aws:RequestedRegion"             = var.region
            "kms:ViaService"                  = "secretsmanager.${var.region}.amazonaws.com"
            "kms:EncryptionContext:SecretARN" = var.secret_arns
          } }
      }])
    })
    ecs = jsonencode({
      Version = "2012-10-17"
      Statement = [
        {
          Sid      = "DefinitionRead", Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"],
          Resource = "*", Condition = local.region
        },
        {
          Sid      = "SteampipeOnly", Effect = "Allow", Action = ["ecs:DescribeServices", "ecs:UpdateService"],
          Resource = "${local.ecs}:service/${var.project}/${var.project}-steampipe", Condition = local.region
        },
        {
          Sid      = "TaskRead", Effect = "Allow", Action = ["ecs:DescribeTasks", "ecs:ListTagsForResource"],
          Resource = "${local.ecs}:task/${var.project}/*", Condition = local.region
        },
        {
          Sid       = "ClusterTaskList", Effect = "Allow", Action = ["ecs:ListTasks"], Resource = "*",
          Condition = { ArnEquals = { "ecs:cluster" = local.cluster }, StringEquals = local.region.StringEquals }
        },
        {
          Sid      = "WorkerConsumer", Effect = "Allow", Action = ["states:DescribeStateMachine"],
          Resource = "arn:aws:states:${var.region}:${var.account_id}:stateMachine:${var.project}-workers", Condition = local.region
        },
        {
          Sid      = "WorkerProbe", Effect = "Allow", Action = ["ecs:RunTask"],
          Resource = "${local.ecs}:task-definition/${var.project}-worker:*",
          Condition = {
            ArnEquals = { "ecs:cluster" = local.cluster }
            StringEquals = {
              "ecs:enable-execute-command"    = "false"
              "aws:RequestedRegion"           = var.region
              "aws:RequestTag/awsops:project" = var.project
              "aws:RequestTag/awsops:purpose" = "ci-runtime-probe"
            }
            "ForAllValues:StringEquals" = { "aws:TagKeys" = ["awsops:project", "awsops:purpose", "awsops:release"] }
          }
        },
        {
          Sid      = "TagNewProbeOnly", Effect = "Allow", Action = ["ecs:TagResource"],
          Resource = "${local.ecs}:task/${var.project}/*",
          Condition = { StringEquals = {
            "aws:RequestedRegion"           = var.region
            "ecs:CreateAction"              = "RunTask"
            "aws:RequestTag/awsops:project" = var.project
            "aws:RequestTag/awsops:purpose" = "ci-runtime-probe"
          } }
        },
        {
          Sid      = "StopProbesOnly", Effect = "Allow", Action = ["ecs:StopTask"],
          Resource = "${local.ecs}:task/${var.project}/*",
          Condition = { StringEquals = {
            "aws:RequestedRegion"            = var.region
            "aws:ResourceTag/awsops:project" = var.project
            "aws:ResourceTag/awsops:purpose" = "ci-runtime-probe"
          } }
        },
        {
          Sid       = "ProbeLogs", Effect = "Allow", Action = ["logs:GetLogEvents"],
          Resource  = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/ecs/${var.project}-worker:log-stream:worker/worker/*",
          Condition = local.region
        },
        {
          Sid       = "WorkerRoles", Effect = "Allow", Action = ["iam:PassRole"], Resource = local.ecs_role_arns,
          Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
        },
      ]
    })
    agentcore = jsonencode({
      Version = "2012-10-17"
      Statement = [
        {
          Sid = "RuntimeCreate", Effect = "Allow", Action = ["bedrock-agentcore:CreateAgentRuntime"], Resource = "*",
          Condition = {
            StringEquals = local.create.StringEquals
            "ForAllValues:StringEquals" = {
              "aws:TagKeys"                      = ["awsops:project"]
              "bedrock-agentcore:subnets"        = var.subnets
              "bedrock-agentcore:securityGroups" = var.security_groups
            }
            Null = { "bedrock-agentcore:subnets" = "false", "bedrock-agentcore:securityGroups" = "false" }
          }
        },
        {
          Sid      = "TaggedResourceCreates", Effect = "Allow",
          Action   = ["bedrock-agentcore:CreateGateway", "bedrock-agentcore:CreateMemory", "bedrock-agentcore:CreateCodeInterpreter"],
          Resource = "*", Condition = local.create
        },
        {
          Sid = "Discovery", Effect = "Allow",
          Action = ["bedrock-agentcore:ListAgentRuntimes", "bedrock-agentcore:ListGateways",
          "bedrock-agentcore:ListMemories", "bedrock-agentcore:ListCodeInterpreters"],
          Resource = "*", Condition = local.region
        },
        {
          Sid = "RuntimeAndDefaultEndpoint", Effect = "Allow",
          Action = ["bedrock-agentcore:UpdateAgentRuntime", "bedrock-agentcore:GetAgentRuntime",
          "bedrock-agentcore:GetAgentRuntimeEndpoint", "bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:InvokeAgentRuntime"],
          Resource = local.runtime, Condition = local.region
        },
        {
          Sid = "ProjectGateways", Effect = "Allow",
          Action = ["bedrock-agentcore:GetGateway", "bedrock-agentcore:UpdateGateway",
            "bedrock-agentcore:ListGatewayTargets", "bedrock-agentcore:GetGatewayTarget", "bedrock-agentcore:CreateGatewayTarget",
          "bedrock-agentcore:UpdateGatewayTarget", "bedrock-agentcore:DeleteGatewayTarget", "bedrock-agentcore:SynchronizeGatewayTargets"],
          Resource = local.gateway, Condition = local.region
        },
        {
          Sid      = "MemoryAndInterpreter", Effect = "Allow",
          Action   = ["bedrock-agentcore:GetMemory", "bedrock-agentcore:GetCodeInterpreter"],
          Resource = [local.memory, local.interpreter], Condition = local.region
        },
        {
          Sid      = "TaggedCredentialCreate", Effect = "Allow", Action = ["bedrock-agentcore:CreateApiKeyCredentialProvider"],
          Resource = local.credentials, Condition = local.create
        },
        {
          Sid = "ProjectCredentials", Effect = "Allow",
          Action = ["bedrock-agentcore:GetApiKeyCredentialProvider", "bedrock-agentcore:UpdateApiKeyCredentialProvider",
          "bedrock-agentcore:DeleteApiKeyCredentialProvider"],
          Resource = local.credentials, Condition = local.region
        },
        {
          Sid      = "TagProjectResources", Effect = "Allow", Action = ["bedrock-agentcore:TagResource"],
          Resource = concat(local.runtime, [local.gateway, local.memory, local.interpreter], local.credentials), Condition = local.create
        },
        {
          Sid = "RuntimeIdentifiers", Effect = "Allow", Action = ["ssm:GetParameter", "ssm:PutParameter"],
          Resource = [for key in ["runtime_arn", "memory_id", "interpreter_id"] :
          "arn:aws:ssm:${var.region}:${var.account_id}:parameter/ops/${var.project}/agentcore/${key}"],
          Condition = local.region
        },
        {
          Sid       = "AgentRole", Effect = "Allow", Action = ["iam:PassRole"],
          Resource  = coalesce(var.agentcore_role_arn, "arn:aws:iam::${var.account_id}:role/${var.project}-agentcore"),
          Condition = { StringEquals = { "iam:PassedToService" = "bedrock-agentcore.amazonaws.com" } }
        },
      ]
    })
  }
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.enabled ? 1 : 0
  arn   = "arn:aws:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

resource "aws_iam_role" "runtime" {
  count = var.enabled ? 1 : 0
  name  = "${var.project}-ci-runtime"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity",
      Principal = { Federated = data.aws_iam_openid_connect_provider.github[0].arn },
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:${var.repository}:environment:${var.environment}"
      } }
    }]
  })
  lifecycle {
    precondition {
      condition = (
        contains(data.aws_iam_openid_connect_provider.github[0].client_id_list, "sts.amazonaws.com") &&
        contains(["https://token.actions.githubusercontent.com", "token.actions.githubusercontent.com"],
        data.aws_iam_openid_connect_provider.github[0].url)
      )
      error_message = "The existing GitHub OIDC provider must have the exact issuer and STS audience; this module never edits it."
    }
  }
}

# Separate managed policies keep each document below 6144 characters without
# exceeding IAM's aggregate inline-role-policy limit.
resource "aws_iam_policy" "runtime" {
  for_each = var.enabled ? { for key, value in local.policies : key => value if key != "agentcore" || var.agentcore_role_arn != null } : {}
  name     = "${var.project}-ci-runtime-${each.key}"
  policy   = each.value
}
resource "aws_iam_role_policy_attachment" "runtime" {
  for_each   = aws_iam_policy.runtime
  role       = aws_iam_role.runtime[0].name
  policy_arn = each.value.arn
}
