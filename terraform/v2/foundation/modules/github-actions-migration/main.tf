terraform {
  required_version = ">= 1.15"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "config" {
  type = object({
    subnets               = list(string)
    security_group        = string
    master_secret_arn     = string
    sql_reader_secret_arn = optional(string)
    kms_key_arns          = list(string)
  })
  default = null
}
variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "An exact AWS account is required."
  }
}
variable "project" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,39}$", var.project))
    error_message = "An exact project name is required."
  }
}
variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[1-9][0-9]*$", var.region))
    error_message = "A commercial AWS region is required."
  }
}

locals {
  count       = var.config == null ? 0 : 1
  ecs         = "arn:aws:ecs:${var.region}:${var.account_id}"
  cluster     = "${local.ecs}:cluster/${var.project}"
  repository  = "arn:aws:ecr:${var.region}:${var.account_id}:repository/${var.project}-web"
  secret_base = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:"
  secrets     = var.config == null ? [] : compact([var.config.master_secret_arn, var.config.sql_reader_secret_arn])
  family      = "${var.project}-ci-migration"
  logs        = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/ecs/${local.family}:*"
  region_only = { StringEquals = { "aws:RequestedRegion" = var.region } }
  task_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike      = { "aws:SourceArn" = "${local.ecs}:*" }
      }
    }]
  })
}

resource "aws_iam_role" "task" {
  count              = local.count
  name               = "${local.family}-task"
  assume_role_policy = local.task_trust
  lifecycle {
    precondition {
      condition = var.config == null ? true : (
        length(var.config.subnets) > 0 && length(var.config.subnets) <= 16 &&
        length(distinct(var.config.subnets)) == length(var.config.subnets) &&
        alltrue([for id in var.config.subnets : can(regex("^subnet-[0-9a-f]{17}$", id))]) &&
        can(regex("^sg-[0-9a-f]{17}$", var.config.security_group)) &&
        can(regex("^${local.secret_base}rds!cluster-[A-Za-z0-9-]+-[A-Za-z0-9]{6}$", var.config.master_secret_arn)) &&
        (var.config.sql_reader_secret_arn == null ? true : can(regex("^${local.secret_base}ops/${var.project}/agent/sql-reader-[A-Za-z0-9]{6}$", var.config.sql_reader_secret_arn))) &&
        length(var.config.kms_key_arns) > 0 &&
        alltrue([for arn in var.config.kms_key_arns : can(regex("^arn:aws:kms:${var.region}:${var.account_id}:key/[a-f0-9-]{36}$", arn))])
      )
      error_message = "Require private subnet/SG IDs and exact same-project, same-account secret/key metadata."
    }
  }
}
resource "aws_iam_role_policy" "task" {
  count = local.count
  role  = aws_iam_role.task[0].id
  name  = "${local.family}-database"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = local.secrets },
      {
        Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.config.kms_key_arns
        Condition = {
          StringEquals = {
            "kms:ViaService"                  = "secretsmanager.${var.region}.amazonaws.com"
            "kms:EncryptionContext:SecretARN" = local.secrets
          }
        }
      },
      {
        Effect   = "Allow", Action = ["rds:DescribeDBClusters"]
        Resource = "arn:aws:rds:${var.region}:${var.account_id}:cluster:${var.project}-aurora"
      }
    ]
  })
}
resource "aws_iam_role" "execution" {
  count              = local.count
  name               = "${local.family}-execution"
  assume_role_policy = local.task_trust
}
resource "aws_cloudwatch_log_group" "migration" {
  count             = local.count
  name              = "/ecs/${local.family}"
  retention_in_days = 14
}
resource "aws_iam_role_policy" "execution" {
  count = local.count
  name  = "${local.family}-image-and-logs"
  role  = aws_iam_role.execution[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*", Condition = local.region_only },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = local.repository },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = local.logs }
    ]
  })
}
resource "aws_iam_policy" "controller" {
  count = local.count
  name  = "${local.family}-controller"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow", Action = ["ecs:RegisterTaskDefinition"], Resource = "${local.ecs}:task-definition/${local.family}:*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region, "aws:RequestTag/Project" = var.project } }
      },
      {
        Effect    = "Allow", Action = ["ecs:TagResource"], Resource = "${local.ecs}:task-definition/${local.family}:*"
        Condition = { StringEquals = { "ecs:CreateAction" = "RegisterTaskDefinition", "aws:RequestTag/Project" = var.project } }
      },
      {
        Effect    = "Allow", Action = ["ecs:RunTask"], Resource = "${local.ecs}:task-definition/${local.family}:*"
        Condition = { ArnEquals = { "ecs:cluster" = local.cluster } }
      },
      {
        Effect    = "Allow", Action = ["ecs:DescribeTasks", "ecs:StopTask"], Resource = "${local.ecs}:task/${var.project}/*"
        Condition = { ArnEquals = { "ecs:cluster" = local.cluster } }
      },
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*", Condition = local.region_only },
      {
        Effect    = "Allow", Action = ["ecs:ListTasks"], Resource = "*"
        Condition = { ArnEquals = { "ecs:cluster" = local.cluster } }
      },
      {
        Effect    = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.task[0].arn, aws_iam_role.execution[0].arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      { Effect = "Allow", Action = ["logs:GetLogEvents"], Resource = local.logs }
    ]
  })
}
output "controller_policy_arn" {
  value = one(aws_iam_policy.controller[*].arn)
}
output "execution_config" {
  value = var.config == null ? null : {
    version           = 1, account = var.account_id, region = var.region, project = var.project
    subnets           = var.config.subnets, security_group = var.config.security_group
    master_secret_arn = var.config.master_secret_arn, sql_reader_secret_arn = var.config.sql_reader_secret_arn
    task_role_arn     = aws_iam_role.task[0].arn, execution_role_arn = aws_iam_role.execution[0].arn
    log_group         = aws_cloudwatch_log_group.migration[0].name
  }
}
