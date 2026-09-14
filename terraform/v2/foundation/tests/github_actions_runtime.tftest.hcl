# Offline plans only. IAM resource kinds/condition keys were checked against AWS
# servicereference.us-east-1.amazonaws.com/v1/{service}/{service}.json.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      arn            = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      url            = "https://token.actions.githubusercontent.com"
      client_id_list = ["sts.amazonaws.com"]
    }
  }
}

variables {
  account_id  = "123456789012"
  region      = "ap-northeast-2"
  project     = "awsops-v2"
  repository  = "Atom-oh/awsops"
  environment = "production"
}

run "default_off" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  assert {
    condition     = length(aws_iam_role.runtime) == 0 && length(aws_iam_policy.runtime) == 0 && length(aws_iam_role_policy_attachment.runtime) == 0 && output.role_arn == null
    error_message = "Runtime release access must default off with no resources."
  }
}

run "scoped_runtime_role_without_state_access" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  variables {
    enabled              = true
    agentcore_role_arn   = "arn:aws:iam::123456789012:role/awsops-v2-agentcore"
    worker_task_role_arn = "arn:aws:iam::123456789012:role/awsops-v2-worker-task"
    execution_role_arn   = "arn:aws:iam::123456789012:role/awsops-v2-task-execution"
    subnets              = ["subnet-0123456789abcdef0"]
    security_groups      = ["sg-0123456789abcdef0"]
    secret_arns = [
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-v2/integrations/credentials-AbCd12",
    ]
  }
  assert {
    condition = (
      aws_iam_role.runtime[0].name == "awsops-v2-ci-runtime" &&
      jsondecode(aws_iam_role.runtime[0].assume_role_policy).Statement[0].Condition.StringEquals == {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = "repo:Atom-oh/awsops:environment:production"
      }
    )
    error_message = "Trust must pin origin/production and must not widen the web role."
  }
  assert {
    condition = alltrue(flatten([
      for policy in aws_iam_policy.runtime : [
        for statement in jsondecode(policy.policy).Statement :
        alltrue([for action in statement.Action :
          !startswith(action, "s3:") && !contains(["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition"], action) &&
          !can(regex("[*?]", action))
        ]) && try(length(keys(statement.Condition)) > 0, false)
      ]
    ]))
    error_message = "No Terraform state access, revision drift, wildcard actions or unconditioned statements."
  }
  assert {
    condition     = alltrue([for policy in aws_iam_policy.runtime : length(policy.policy) <= 6144])
    error_message = "Each managed policy must fit the AWS 6144-character limit."
  }
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_policy.runtime["artifacts"].policy).Statement :
      try(toset(statement.Resource) == toset(var.secret_arns), false)
      if contains(statement.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "Secret reads may include only explicit integration secret ARNs; database secrets belong to the private task."
  }
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.runtime["ecs"].policy).Statement :
      contains(s.Action, "ecs:RunTask") &&
      try(s.Resource == "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/awsops-v2-worker:*", false) &&
      try(s.Condition.StringEquals["aws:RequestTag/awsops:project"] == "awsops-v2", false) &&
      try(s.Condition.StringEquals["aws:RequestTag/awsops:purpose"] == "ci-runtime-probe", false) &&
      try(s.Condition.StringEquals["ecs:enable-execute-command"] == "false", false) &&
      !can(s.Condition.Bool["ecs:enable-execute-command"])
    ])
    error_message = "RunTask must be a tagged, non-exec probe using the existing worker family."
  }
  assert {
    condition = alltrue([
      for candidate in [
        "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/awsops_v2_agent-ABCDEFGHIJ",
        "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/awsops_v2_agent-ABCDEFGHIJ/runtime-endpoint/DEFAULT",
        ] : anytrue([
          for arn in local.runtime : can(regex("^${replace(replace(arn, "*", ".*"), "?", ".")}$", candidate))
      ])
      ]) && !anytrue([
      for arn in local.runtime : can(regex("^${replace(replace(arn, "*", ".*"), "?", ".")}$",
      "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/awsops_v2_agent-ABCDEFGHIJ/runtime-endpoint/OTHER"))
    ])
    error_message = "Runtime ID patterns must not absorb arbitrary endpoint suffixes."
  }
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.runtime["ecs"].policy).Statement :
      contains(s.Action, "ecs:StopTask") &&
      try(s.Condition.StringEquals["aws:ResourceTag/awsops:project"] == "awsops-v2", false) &&
      try(s.Condition.StringEquals["aws:ResourceTag/awsops:purpose"] == "ci-runtime-probe", false)
    ])
    error_message = "Cleanup permission must exclude ordinary production tasks."
  }
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.runtime["agentcore"].policy).Statement :
      contains(s.Action, "bedrock-agentcore:CreateAgentRuntime") &&
      try(s.Condition.StringEquals["aws:RequestTag/awsops:project"] == "awsops-v2", false)
      ]) && anytrue([
      for s in jsondecode(aws_iam_policy.runtime["agentcore"].policy).Statement :
      contains(s.Action, "bedrock-agentcore:GetCodeInterpreter") &&
      contains(flatten([s.Resource]), "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:code-interpreter-custom/awsops_v2_code_interpreter-*")
    ])
    error_message = "AgentCore creates require project tags; custom interpreter ARN resource kinds must be correct."
  }
}

run "reject_foreign_repository" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  variables { repository = "aws-samples/sample-awsops" }
  expect_failures = [var.repository]
}

run "reject_nonproduction" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  variables { environment = "development" }
  expect_failures = [var.environment]
}

run "reject_foreign_role" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  variables { worker_task_role_arn = "arn:aws:iam::999999999999:role/awsops-v2-worker-task" }
  expect_failures = [var.worker_task_role_arn]
}

run "reject_wildcard_secret" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  variables { secret_arns = ["arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:*"] }
  expect_failures = [var.secret_arns]
}

run "reject_database_secret_in_runtime_role" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  variables {
    secret_arns = [
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-AbCd12",
    ]
  }
  expect_failures = [var.secret_arns]
}

run "migration_artifact_permission_is_opt_in" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  variables {
    enabled           = true
    migration_enabled = true
  }
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.runtime["artifacts"].policy).Statement :
      contains(s.Action, "ecr:PutImage") &&
      try(s.Resource == "arn:aws:ecr:ap-northeast-2:123456789012:repository/awsops-v2-web", false)
    ])
    error_message = "The shared migration image repository requires explicit opt-in."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.runtime["artifacts"].policy).Statement :
      !contains(s.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "Migration enablement must not grant the controller direct database credentials."
  }
}

run "reject_incompatible_existing_oidc_provider" {
  command = plan
  module { source = "./modules/github-actions-runtime" }
  variables { enabled = true }
  override_data {
    target = data.aws_iam_openid_connect_provider.github[0]
    values = {
      url            = "https://token.actions.githubusercontent.com"
      client_id_list = ["other-audience"]
    }
  }
  expect_failures = [aws_iam_role.runtime]
}
