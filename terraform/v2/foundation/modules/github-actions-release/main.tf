terraform {
  required_version = ">= 1.15"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# Construct existing resource identities from metadata rather than depending on
# the foundation's ECR, ECS, database or global OIDC-provider resources.
locals {
  ecs_cluster_arn  = "arn:aws:ecs:${var.region}:${var.account_id}:cluster/${var.project}"
  state_bucket_arn = "arn:aws:s3:::${coalesce(var.state_bucket, "unconfigured")}"
  region_condition = {
    StringEquals = { "aws:RequestedRegion" = var.region }
  }
}

resource "aws_iam_role" "release" {
  count = var.enabled ? 1 : 0
  name  = "${var.project}-ci-release"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "sts:AssumeRoleWithWebIdentity"
      Principal = {
        Federated = "arn:aws:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com"
      }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.repository}:environment:${var.environment}"
        }
      }
    }]
  })
}

# Only metadata is managed. The operator supplies the verifier value separately.
resource "aws_secretsmanager_secret" "verifier" {
  count                   = var.enabled ? 1 : 0
  name                    = "${var.project}/ci/deployment-verifier"
  description             = "Existing deployment verifier credentials, populated by the operator."
  recovery_window_in_days = 30
}

resource "aws_iam_role_policy" "release" {
  count = var.enabled ? 1 : 0
  name  = "${var.project}-ci-web-release"
  role  = aws_iam_role.release[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EcrAuthentication"
        Effect    = "Allow"
        Action    = ["ecr:GetAuthorizationToken"]
        Resource  = "*"
        Condition = local.region_condition
      },
      {
        Sid    = "WebImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
        ]
        Resource  = "arn:aws:ecr:${var.region}:${var.account_id}:repository/${var.project}-web"
        Condition = local.region_condition
      },
      {
        Sid      = "BackendBucketMetadata"
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation", "s3:ListBucket"]
        Resource = local.state_bucket_arn
        Condition = {
          StringEquals = { "s3:ResourceAccount" = var.account_id }
        }
      },
      {
        Sid      = "BackendStateRead"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${local.state_bucket_arn}/${coalesce(var.state_key, "unconfigured")}"
        Condition = {
          StringEquals = { "s3:ResourceAccount" = var.account_id }
        }
      },
      {
        Sid       = "ExplicitReleaseSecrets"
        Effect    = "Allow"
        Action    = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource  = concat(var.migration_secret_arns, [aws_secretsmanager_secret.verifier[0].arn])
        Condition = local.region_condition
      },
      {
        Sid       = "WebService"
        Effect    = "Allow"
        Action    = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource  = "arn:aws:ecs:${var.region}:${var.account_id}:service/${var.project}/${var.project}-web"
        Condition = local.region_condition
      },
      {
        Sid       = "ClusterTasks"
        Effect    = "Allow"
        Action    = ["ecs:DescribeTasks"]
        Resource  = "arn:aws:ecs:${var.region}:${var.account_id}:task/${var.project}/*"
        Condition = local.region_condition
      },
      {
        # ECS ListTasks can be authorized without a container-instance resource;
        # the cluster condition is required for this Fargate service list.
        Sid      = "ListClusterTasks"
        Effect   = "Allow"
        Action   = ["ecs:ListTasks"]
        Resource = "*"
        Condition = {
          ArnEquals    = { "ecs:cluster" = local.ecs_cluster_arn }
          StringEquals = { "aws:RequestedRegion" = var.region }
        }
      },
      {
        # ECS DescribeTaskDefinition does not support resource-level scoping.
        Sid       = "RegionalTaskDefinitions"
        Effect    = "Allow"
        Action    = ["ecs:DescribeTaskDefinition"]
        Resource  = "*"
        Condition = local.region_condition
      },
    ]
  })
}
