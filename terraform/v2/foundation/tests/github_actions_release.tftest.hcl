# Run with Terraform 1.15.7, init -backend=false, and no AWS credentials.
# The alternate module avoids planning unrelated foundation infrastructure.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      client_id_list = ["sts.amazonaws.com"]
      url            = "https://token.actions.githubusercontent.com"
    }
  }
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
    condition     = !var.enabled && length(data.aws_iam_openid_connect_provider.github) == 0 && length(aws_iam_role.release) == 0 && length(aws_iam_role_policy.release) == 0 && length(aws_secretsmanager_secret.verifier) == 0
    error_message = "The default must create no CI role, policy or verifier secret."
  }
  assert {
    condition     = output.release_role_arn == null && output.smoke_secret_arn == null
    error_message = "Disabled CI outputs must remain null."
  }
  assert {
    condition     = length(var.secret_kms_key_arns) == 0
    error_message = "The optional secret-key allowlist must default to empty."
  }
}

run "enabled_release_is_exactly_scoped" {
  command = plan
  module {
    source = "./modules/github-actions-release"
  }
  variables {
    enabled = true
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
      "ecr:DescribeRepositories", "rds:DescribeDBClusters",
      "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret",
      "ecs:UpdateService", "ecs:DescribeServices", "ecs:DescribeTasks",
      "ecs:ListTasks", "ecs:DescribeTaskDefinition",
    ])
    error_message = "Grant only web-release operations: no PassRole, RunTask, IAM administration, AgentCore, secret writes or backend writes."
  }
  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      [for action in s.Action : startswith(action, "kms:")]
    ]))
    error_message = "An empty secret-key allowlist must add no KMS permissions."
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
      for statement in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      alltrue([for action in statement.Action : !startswith(action, "s3:")]) &&
      alltrue([for resource in flatten([statement.Resource]) : !startswith(resource, "arn:aws:s3:")])
    ])
    error_message = "The CI role must have no S3/backend access, including reads of secret-bearing Terraform state."
  }
  assert {
    condition = jsonencode([
      for statement in jsondecode(aws_iam_role_policy.release[0].policy).Statement : statement
      if anytrue([for action in statement.Action : startswith(action, "rds:")])
      ]) == jsonencode([{
        Sid       = "OwnDatabaseMetadata", Effect = "Allow", Action = ["rds:DescribeDBClusters"],
        Resource  = "arn:aws:rds:ap-northeast-2:123456789012:cluster:awsops-fixture-aurora",
        Condition = { StringEquals = { "aws:RequestedRegion" = "ap-northeast-2" } }
    }])
    error_message = "RDS discovery must only describe the own regional Aurora cluster."
  }

  assert {
    condition = (length(data.aws_iam_openid_connect_provider.github) == 1 &&
      data.aws_iam_openid_connect_provider.github[0].arn == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    )
    error_message = "Bootstrap must look up the existing provider, never manage or replace it."
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

run "reject_malformed_region" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { region = "ap-northeast-2*" }
  expect_failures = [var.region]
}

run "decrypt_only_explicit_keys_via_approved_secrets" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    enabled = true
    migration_secret_arns = [
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-11111111-1111-1111-1111-111111111111-AbCd12",
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-fixture/agent/sql-reader-EfGh34",
    ]
    secret_kms_key_arns = [
      "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-2222-3333-4444-555555555555",
      "arn:aws:kms:ap-northeast-2:123456789012:key/mrk-0123456789abcdef0123456789abcdef",
    ]
  }

  assert {
    condition = jsonencode([
      for s in jsondecode(aws_iam_role_policy.release[0].policy).Statement : s
      if anytrue([for action in s.Action : startswith(action, "kms:")])
      ]) == jsonencode([{
        Sid      = "DecryptApprovedSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.secret_kms_key_arns
        Condition = {
          StringEquals = {
            "aws:RequestedRegion"             = "ap-northeast-2"
            "kms:ViaService"                  = "secretsmanager.ap-northeast-2.amazonaws.com"
            "kms:EncryptionContext:SecretARN" = concat(var.migration_secret_arns, [output.smoke_secret_arn])
          }
        }
    }])
    error_message = "KMS may only decrypt the explicit keys via regional Secrets Manager with an approved migration/verifier SecretARN encryption context."
  }
  assert {
    condition = (
      length(aws_iam_role.release) == 1 && length(aws_iam_role_policy.release) == 1 &&
      length(aws_secretsmanager_secret.verifier) == 1
    )
    error_message = "Adding key metadata must keep the existing three CI resources."
  }
}

run "disabled_with_key_metadata_creates_no_resources" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    secret_kms_key_arns = [
      "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-2222-3333-4444-555555555555",
    ]
  }
  assert {
    condition     = length(aws_iam_role.release) == 0 && length(aws_iam_role_policy.release) == 0 && length(aws_secretsmanager_secret.verifier) == 0
    error_message = "Existing key identifiers cannot activate the default-off module."
  }
}

run "reject_foreign_account_key" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    secret_kms_key_arns = [
      "arn:aws:kms:ap-northeast-2:999999999999:key/11111111-2222-3333-4444-555555555555",
    ]
  }
  expect_failures = [var.secret_kms_key_arns]
}

run "reject_foreign_region_key" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    secret_kms_key_arns = [
      "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555",
    ]
  }
  expect_failures = [var.secret_kms_key_arns]
}

run "reject_foreign_partition_key" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    secret_kms_key_arns = [
      "arn:aws-cn:kms:ap-northeast-2:123456789012:key/11111111-2222-3333-4444-555555555555",
    ]
  }
  expect_failures = [var.secret_kms_key_arns]
}

run "reject_key_alias_arn" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    secret_kms_key_arns = [
      "arn:aws:kms:ap-northeast-2:123456789012:alias/awsops-fixture-aurora",
    ]
  }
  expect_failures = [var.secret_kms_key_arns]
}

run "reject_key_alias_name" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { secret_kms_key_arns = ["alias/awsops-fixture-aurora"] }
  expect_failures = [var.secret_kms_key_arns]
}

run "reject_bare_key_id" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { secret_kms_key_arns = ["11111111-2222-3333-4444-555555555555"] }
  expect_failures = [var.secret_kms_key_arns]
}

run "reject_wildcard_key" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    secret_kms_key_arns = [
      "arn:aws:kms:ap-northeast-2:123456789012:key/*",
    ]
  }
  expect_failures = [var.secret_kms_key_arns]
}

run "reject_invalid_key_id" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    secret_kms_key_arns = [
      "arn:aws:kms:ap-northeast-2:123456789012:key/not-a-key-uuid",
    ]
  }
  expect_failures = [var.secret_kms_key_arns]
}

run "reject_duplicate_key_arns" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables {
    secret_kms_key_arns = [
      "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-2222-3333-4444-555555555555",
      "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-2222-3333-4444-555555555555",
    ]
  }
  expect_failures = [var.secret_kms_key_arns]
}

run "release_only_needs_no_migration_credentials" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { enabled = true }
  assert {
    condition = length(var.migration_secret_arns) == 0 && alltrue([
      for statement in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      try(toset(statement.Resource) == toset([output.smoke_secret_arn]), false)
      if contains(statement.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "Release-only bootstrap must not require or grant an Aurora master/reader secret."
  }
  assert {
    condition = !anytrue(flatten([
      for statement in jsondecode(aws_iam_role_policy.release[0].policy).Statement :
      [for action in statement.Action : startswith(action, "cloudfront:") || startswith(action, "s3:")]
    ]))
    error_message = "The release role must grant neither CloudFront nor backend access."
  }
}

run "reject_provider_without_sts_audience" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { enabled = true }
  override_data {
    target = data.aws_iam_openid_connect_provider.github[0]
    values = {
      client_id_list = ["different-audience"]
      url            = "https://token.actions.githubusercontent.com"
    }
  }
  expect_failures = [aws_iam_role.release]
}

run "reject_wrong_provider_url" {
  command = plan
  module { source = "./modules/github-actions-release" }
  variables { enabled = true }
  override_data {
    target = data.aws_iam_openid_connect_provider.github[0]
    values = {
      client_id_list = ["sts.amazonaws.com"]
      url            = "https://token.actions.githubusercontent.com.untrusted.example"
    }
  }
  expect_failures = [aws_iam_role.release]
}
