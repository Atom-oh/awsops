# Offline plans against the small child module, not the complete foundation.
# Use terraform test -filter=tests/github_actions_migration.tftest.hcl.
mock_provider "aws" {
  override_during = plan
}

variables {
  account_id = "123456789012"
  region     = "ap-northeast-2"
  project    = "awsops-v2"
}

run "default_off" {
  command = plan
  module { source = "./modules/github-actions-migration" }
  assert {
    condition = (
      length(aws_iam_role.task) == 0 && length(aws_iam_role.execution) == 0 &&
      length(aws_iam_role_policy.task) == 0 && length(aws_iam_role_policy.execution) == 0 &&
      length(aws_iam_policy.controller) == 0 && length(aws_cloudwatch_log_group.migration) == 0 &&
      output.execution_config == null && output.controller_policy_arn == null
    )
    error_message = "Unconfigured private migrations must create no infrastructure or permissions."
  }
}

run "scoped_private_migration" {
  command = plan
  module { source = "./modules/github-actions-migration" }
  variables {
    config = {
      subnets               = ["subnet-0123456789abcdef0"]
      security_group        = "sg-0123456789abcdef0"
      master_secret_arn     = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-AbCd12"
      sql_reader_secret_arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-v2/agent/sql-reader-EfGh34"
      kms_key_arns          = ["arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc"]
    }
  }
  override_resource {
    target          = aws_iam_role.task[0]
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:role/awsops-v2-ci-migration-task"
    }
  }
  override_resource {
    target          = aws_iam_role.execution[0]
    override_during = plan
    values = {
      arn = "arn:aws:iam::123456789012:role/awsops-v2-ci-migration-execution"
    }
  }
  assert {
    condition = (
      aws_iam_role.task[0].name == "awsops-v2-ci-migration-task" &&
      aws_iam_role.execution[0].name == "awsops-v2-ci-migration-execution" &&
      aws_cloudwatch_log_group.migration[0].name == "/ecs/awsops-v2-ci-migration" &&
      aws_cloudwatch_log_group.migration[0].retention_in_days == 14
    )
    error_message = "Migration task/execution roles and logs must be dedicated to this project."
  }
  assert {
    condition = alltrue([
      for role in concat(aws_iam_role.task, aws_iam_role.execution) :
      jsondecode(role.assume_role_policy).Statement[0].Principal == { Service = "ecs-tasks.amazonaws.com" } &&
      jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == var.account_id &&
      jsondecode(role.assume_role_policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:ecs:ap-northeast-2:123456789012:*"
    ])
    error_message = "Task roles must trust ECS only in the expected account and region."
  }
  assert {
    condition = alltrue([
      for policy in concat(aws_iam_role_policy.task, aws_iam_role_policy.execution, aws_iam_policy.controller) :
      alltrue([
        for statement in jsondecode(policy.policy).Statement :
        alltrue([for action in statement.Action : !can(regex("[*?]", action)) && !startswith(action, "s3:")]) &&
        (contains(flatten([statement.Resource]), "*") ? try(length(keys(statement.Condition)) > 0, false) : true)
      ])
    ])
    error_message = "No state access, wildcard actions, or unconditioned Resource:* permissions."
  }
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.task[0].policy).Statement :
      toset(flatten([statement.Resource])) == toset([var.config.master_secret_arn, var.config.sql_reader_secret_arn])
      if contains(statement.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "Only the private task may read the two explicitly approved database secrets."
  }
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_policy.controller[0].policy).Statement :
      alltrue([for action in statement.Action : !startswith(action, "secretsmanager:") && !startswith(action, "kms:")])
    ])
    error_message = "The Actions controller must receive neither credentials nor decryption permission."
  }
  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_role_policy.task[0].policy).Statement :
      contains(statement.Action, "kms:Decrypt") &&
      toset(flatten([statement.Resource])) == toset(var.config.kms_key_arns) &&
      try(statement.Condition.StringEquals["kms:ViaService"] == "secretsmanager.ap-northeast-2.amazonaws.com", false) &&
      try(toset(statement.Condition.StringEquals["kms:EncryptionContext:SecretARN"]) == toset([var.config.master_secret_arn, var.config.sql_reader_secret_arn]), false)
    ])
    error_message = "Decryption must bind approved keys to the exact Secrets Manager secret ARNs."
  }
  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_role_policy.task[0].policy).Statement :
      contains(statement.Action, "rds:DescribeDBClusters") &&
      statement.Resource == "arn:aws:rds:ap-northeast-2:123456789012:cluster:awsops-v2-aurora"
    ])
    error_message = "The executor needs an independent read of the owned Aurora cluster."
  }
  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_policy.controller[0].policy).Statement :
      contains(statement.Action, "iam:PassRole") &&
      toset(flatten([statement.Resource])) == toset([
        "arn:aws:iam::123456789012:role/awsops-v2-ci-migration-task",
        "arn:aws:iam::123456789012:role/awsops-v2-ci-migration-execution",
      ]) &&
      try(statement.Condition.StringEquals["iam:PassedToService"] == "ecs-tasks.amazonaws.com", false)
    ])
    error_message = "PassRole may delegate only the two dedicated migration roles to ECS tasks."
  }
  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_policy.controller[0].policy).Statement :
      contains(statement.Action, "ecs:RegisterTaskDefinition") &&
      statement.Resource == "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/awsops-v2-ci-migration:*" &&
      try(statement.Condition.StringEquals["aws:RequestTag/Project"] == var.project, false) &&
      try(statement.Condition.StringEquals["aws:RequestedRegion"] == var.region, false)
    ])
    error_message = "RegisterTaskDefinition supports resource scoping and must use only the migration family."
  }
  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_policy.controller[0].policy).Statement :
      contains(statement.Action, "ecs:RunTask") &&
      statement.Resource == "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/awsops-v2-ci-migration:*" &&
      try(statement.Condition.ArnEquals["ecs:cluster"] == "arn:aws:ecs:ap-northeast-2:123456789012:cluster/awsops-v2", false)
      ]) && anytrue([
      for statement in jsondecode(aws_iam_policy.controller[0].policy).Statement :
      contains(statement.Action, "ecs:ListTasks") &&
      try(statement.Condition.ArnEquals["ecs:cluster"] == "arn:aws:ecs:ap-northeast-2:123456789012:cluster/awsops-v2", false)
    ])
    error_message = "Launching and lost-response reconciliation require permissions in only the owned cluster."
  }
  assert {
    condition = (
      toset(keys(output.execution_config)) == toset([
        "version", "account", "region", "project", "subnets", "security_group",
        "master_secret_arn", "sql_reader_secret_arn", "task_role_arn", "execution_role_arn", "log_group",
      ]) &&
      output.execution_config.task_role_arn == "arn:aws:iam::123456789012:role/awsops-v2-ci-migration-task" &&
      output.execution_config.execution_role_arn == "arn:aws:iam::123456789012:role/awsops-v2-ci-migration-execution"
    )
    error_message = "The exported configuration must match the helper interface and contain metadata only."
  }
}

run "reader_disabled" {
  command = plan
  module { source = "./modules/github-actions-migration" }
  variables {
    config = {
      subnets           = ["subnet-0123456789abcdef0"]
      security_group    = "sg-0123456789abcdef0"
      master_secret_arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-AbCd12"
      kms_key_arns      = ["arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc"]
    }
  }
  assert {
    condition = output.execution_config.sql_reader_secret_arn == null && alltrue([
      for statement in jsondecode(aws_iam_role_policy.task[0].policy).Statement :
      flatten([statement.Resource]) == [var.config.master_secret_arn]
      if contains(statement.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "Disabled SQL reader must add neither a secret grant nor a fabricated ARN."
  }
}

run "reject_foreign_account" {
  command = plan
  module { source = "./modules/github-actions-migration" }
  variables { account_id = "*" }
  expect_failures = [var.account_id]
}

run "reject_foreign_master" {
  command = plan
  module { source = "./modules/github-actions-migration" }
  variables {
    config = {
      subnets           = ["subnet-0123456789abcdef0"]
      security_group    = "sg-0123456789abcdef0"
      master_secret_arn = "arn:aws:secretsmanager:ap-northeast-2:999999999999:secret:rds!cluster-example-AbCd12"
      kms_key_arns      = ["arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc"]
    }
  }
  expect_failures = [aws_iam_role.task]
}

run "reject_foreign_key" {
  command = plan
  module { source = "./modules/github-actions-migration" }
  variables {
    config = {
      subnets           = ["subnet-0123456789abcdef0"]
      security_group    = "sg-0123456789abcdef0"
      master_secret_arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-AbCd12"
      kms_key_arns      = ["arn:aws:kms:ap-northeast-2:999999999999:key/12345678-1234-1234-1234-123456789abc"]
    }
  }
  expect_failures = [aws_iam_role.task]
}

run "reject_wildcard_reader" {
  command = plan
  module { source = "./modules/github-actions-migration" }
  variables {
    config = {
      subnets               = ["subnet-0123456789abcdef0"]
      security_group        = "sg-0123456789abcdef0"
      master_secret_arn     = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-AbCd12"
      sql_reader_secret_arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-v2/agent/sql-reader-*"
      kms_key_arns          = ["arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc"]
    }
  }
  expect_failures = [aws_iam_role.task]
}

# This is a regression test, not an accepted broad grant. A prefix-only check
# currently permits all RDS-managed master secrets in the account and region.
run "reject_wildcard_master" {
  command = plan
  module { source = "./modules/github-actions-migration" }
  variables {
    config = {
      subnets           = ["subnet-0123456789abcdef0"]
      security_group    = "sg-0123456789abcdef0"
      master_secret_arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-*"
      kms_key_arns      = ["arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789abc"]
    }
  }
  expect_failures = [aws_iam_role.task]
}
