# Run with Terraform 1.15.7, init -backend=false, and no AWS credentials.
# The alternate module avoids planning unrelated foundation infrastructure.
mock_provider "aws" {
  override_during = plan
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/awsops-fixture-ci-release" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:awsops-fixture/ci/deployment-verifier-AbCd12"
    }
  }
}

variables {
  account_id  = "123456789012"
  project     = "awsops-fixture"
  region      = "ap-northeast-2"
  repository  = "Atom-oh/awsops"
  environment = "production"
}

run "default_off_without_backend_or_secret_inputs" {
  command = plan
  module {
    source = "./modules/github-actions-release"
  }

  assert {
    condition     = !var.enabled && length(aws_iam_role.release) == 0 && length(aws_iam_role_policy.release) == 0 && length(aws_secretsmanager_secret.verifier) == 0
    error_message = "The default must create no CI role, policy or verifier secret."
  }
  assert {
    condition     = output.release_role_arn == null && output.smoke_secret_arn == null
    error_message = "Disabled CI outputs must remain null."
  }
}

run "enabled_release_is_exactly_scoped" {
  command = plan
  module {
    source = "./modules/github-actions-release"
  }
  variables {
    enabled      = true
    state_bucket = "awsops-fixture-tfstate"
    state_key    = "production/foundation.tfstate"
    migration_secret_arns = [
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-11111111-1111-1111-1111-111111111111-AbCd12",
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-fixture/agent/sql-reader-EfGh34",
    ]
  }

  assert {
    condition = (
      length(aws_iam_role.release) == 1 && length(aws_iam_role_policy.release) == 1 &&
      length(aws_secretsmanager_secret.verifier) == 1 &&
      aws_iam_role.release[0].name == "awsops-fixture-ci-release" &&
      output.release_role_arn == aws_iam_role.release[0].arn
    )
    error_message = "Enable only the project release role, its inline policy, and secret metadata."
  }
  assert {
    condition = jsondecode(aws_iam_role.release[0].assume_role_policy).Statement == [{
      Effect = "Allow"
      Action = "sts:AssumeRoleWithWebIdentity"
      Principal = {
        Federated = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:Atom-oh/awsops:environment:production"
        }
      }
    }]
    error_message = "Trust only the existing account provider, exact repository/environment subject, and STS audience."
  }
  assert {
    condition = (
      aws_secretsmanager_secret.verifier[0].name == "awsops-fixture/ci/deployment-verifier" &&
      output.smoke_secret_arn == aws_secretsmanager_secret.verifier[0].arn
    )
    error_message = "The verifier output must refer to the project metadata-only secret."
  }
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement : s.Action
      ])) == toset([
      "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage",
      "s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject",
      "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret",
      "ecs:UpdateService", "ecs:DescribeServices", "ecs:DescribeTasks",
      "ecs:ListTasks", "ecs:DescribeTaskDefinition",
    ])
    error_message = "Grant only web-release operations: no PassRole, RunTask, IAM administration, AgentCore, secret writes or backend writes."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      s.Effect == "Allow" && !can(s.Principal) &&
      alltrue([for action in s.Action : length(regexall("[*?]", action)) == 0]) &&
      alltrue([
        for resource in flatten([s.Resource]) :
        length(regexall("[*?]", resource)) == 0 || try(length(keys(s.Condition)) > 0, false)
      ])
    ])
    error_message = "Permission statements must not contain principals, wildcard actions or unconditioned wildcard resources."
  }
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      toset(s.Action) == toset(["ecr:GetAuthorizationToken"]) && try(s.Resource == "*", false) &&
      try(s.Condition.StringEquals["aws:RequestedRegion"] == "ap-northeast-2", false)
    ])
    error_message = "ECR authorization must have a RequestedRegion condition."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      s.Resource == "arn:aws:ecr:ap-northeast-2:123456789012:repository/awsops-fixture-web"
      if anytrue([for action in s.Action : startswith(action, "ecr:") && action != "ecr:GetAuthorizationToken"])
    ])
    error_message = "Every repository read/write must name only the project web ECR repository."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      toset(s.Action) == toset(["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]) &&
      try(toset(s.Resource) == setunion(toset(var.migration_secret_arns), toset([output.smoke_secret_arn])), false)
      if anytrue([for action in s.Action : startswith(action, "secretsmanager:")])
    ])
    error_message = "Secret reads must contain only explicit existing migration ARNs and the new verifier secret."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      s.Resource == "arn:aws:s3:::awsops-fixture-tfstate/production/foundation.tfstate" &&
      try(s.Condition.StringEquals["s3:ResourceAccount"] == "123456789012", false)
      if contains(s.Action, "s3:GetObject")
      ]) && alltrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      s.Resource == "arn:aws:s3:::awsops-fixture-tfstate" &&
      try(s.Condition.StringEquals["s3:ResourceAccount"] == "123456789012", false)
      if contains(s.Action, "s3:ListBucket") || contains(s.Action, "s3:GetBucketLocation")
    ])
    error_message = "Backend access must stay read-only, use the exact bucket/key, and constrain bucket ownership."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      s.Resource == "arn:aws:ecs:ap-northeast-2:123456789012:service/awsops-fixture/awsops-fixture-web"
      if contains(s.Action, "ecs:UpdateService") || contains(s.Action, "ecs:DescribeServices")
      ]) && alltrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      s.Resource == "arn:aws:ecs:ap-northeast-2:123456789012:task/awsops-fixture/*" &&
      try(s.Condition.StringEquals["aws:RequestedRegion"] == "ap-northeast-2", false)
      if contains(s.Action, "ecs:DescribeTasks")
    ])
    error_message = "ECS service operations and task descriptions must stay within the project web service/cluster."
  }
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      toset(s.Action) == toset(["ecs:ListTasks"]) && try(s.Resource == "*", false) &&
      try(s.Condition.ArnEquals["ecs:cluster"] == "arn:aws:ecs:ap-northeast-2:123456789012:cluster/awsops-fixture", false) &&
      try(s.Condition.StringEquals["aws:RequestedRegion"] == "ap-northeast-2", false)
      ]) && anytrue([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      toset(s.Action) == toset(["ecs:DescribeTaskDefinition"]) && try(s.Resource == "*", false) &&
      try(s.Condition.StringEquals["aws:RequestedRegion"] == "ap-northeast-2", false)
    ])
    error_message = "ListTasks requires cluster plus region conditions; DescribeTaskDefinition requires Resource=* with region."
  }
}

run "reject_foreign_repository" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { repository = "aws-samples/sample-awsops" }
  expect_failures = [var.repository]
}

run "reject_branch_subject_environment" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { environment = "refs/heads/main" }
  expect_failures = [var.environment]
}

run "reject_invalid_account" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { account_id = "12345678901*" }
  expect_failures = [var.account_id]
}

run "reject_noncommercial_region" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { region = "cn-north-1" }
  expect_failures = [var.region]
}

run "reject_wildcard_project" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { project = "awsops-*" }
  expect_failures = [var.project]
}

run "reject_missing_enabled_backend" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    enabled = true
    migration_secret_arns = [
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:master-AbCd12",
    ]
  }
  expect_failures = [var.state_bucket, var.state_key]
}

run "reject_empty_enabled_secret_allowlist" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    enabled      = true
    state_bucket = "awsops-fixture-tfstate"
    state_key    = "production/foundation.tfstate"
  }
  expect_failures = [var.migration_secret_arns]
}

run "reject_wildcard_state_bucket" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { state_bucket = "awsops-*" }
  expect_failures = [var.state_bucket]
}

run "reject_wildcard_state_key" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { state_key = "production/*" }
  expect_failures = [var.state_key]
}

run "reject_foreign_account_secret" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    migration_secret_arns = [
      "arn:aws:secretsmanager:ap-northeast-2:999999999999:secret:master-AbCd12",
    ]
  }
  expect_failures = [var.migration_secret_arns]
}

run "reject_foreign_region_secret" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    migration_secret_arns = [
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:master-AbCd12",
    ]
  }
  expect_failures = [var.migration_secret_arns]
}

run "reject_wildcard_secret" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    migration_secret_arns = [
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:master-*",
    ]
  }
  expect_failures = [var.migration_secret_arns]
}

run "reject_secret_name_instead_of_full_arn" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { migration_secret_arns = ["ops/awsops-fixture/agent/sql-reader"] }
  expect_failures = [var.migration_secret_arns]
}

run "reject_foreign_partition_secret" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    migration_secret_arns = [
      "arn:aws-cn:secretsmanager:ap-northeast-2:123456789012:secret:master-AbCd12",
    ]
  }
  expect_failures = [var.migration_secret_arns]
}

run "reject_duplicate_secret_arns" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    migration_secret_arns = [
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:master-AbCd12",
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:master-AbCd12",
    ]
  }
  expect_failures = [var.migration_secret_arns]
}

run "reject_ambiguous_state_key" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { state_key = "production/../foundation.tfstate" }
  expect_failures = [var.state_key]
}

run "reject_malformed_region" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { region = "ap-northeast-2*" }
  expect_failures = [var.region]
}
