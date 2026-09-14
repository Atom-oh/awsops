# Explicit existing metadata avoids reading the whole Terraform state in CI.
variable "github_actions_migration" {
  description = "Private migration executor configuration; null leaves all resources absent. Use existing production network/secret metadata from a reviewed plan."
  type = object({
    subnets               = list(string)
    security_group        = string
    master_secret_arn     = string
    sql_reader_secret_arn = optional(string)
    kms_key_arns          = list(string)
  })
  default = null
}

module "github_actions_migration" {
  source     = "./modules/github-actions-migration"
  config     = var.github_actions_migration
  account_id = data.aws_caller_identity.current.account_id
  project    = var.project
  region     = var.region
}

resource "aws_iam_role_policy_attachment" "github_actions_web_migration" {
  count      = var.github_actions_enabled && var.github_actions_migration != null ? 1 : 0
  role       = "${var.project}-ci-release"
  policy_arn = module.github_actions_migration.controller_policy_arn
  depends_on = [module.github_actions_release]
}

output "github_actions_migration_config" {
  description = "Whitelisted nonsecret private execution metadata for AWSOPS_MIGRATION_CONFIG_JSON. No secret values or Terraform state."
  value       = module.github_actions_migration.execution_config
}
