# Operator deployment access only. Does not change product/agent mutation gates
# or manage the account's existing token.actions.githubusercontent.com provider.
variable "github_actions_enabled" {
  type        = bool
  default     = false
  nullable    = false
  description = "Opt in to the origin production GitHub Actions web-release role and verifier-secret metadata."
}

variable "github_actions_migration_secret_arns" {
  type        = list(string)
  default     = []
  nullable    = false
  description = "Optional existing migration secret ARNs; grant only for an identified reachable private executor. No values."
}

variable "github_actions_secret_kms_key_arns" {
  type        = list(string)
  default     = []
  nullable    = false
  description = "Optional existing same-account/region KMS key ARNs for approved migration/verifier secrets; no aliases or key creation."
}

module "github_actions_release" {
  source = "./modules/github-actions-release"

  enabled               = var.github_actions_enabled
  account_id            = data.aws_caller_identity.current.account_id
  project               = var.project
  region                = var.region
  repository            = "Atom-oh/awsops"
  environment           = "production"
  migration_secret_arns = var.github_actions_migration_secret_arns
  secret_kms_key_arns   = var.github_actions_secret_kms_key_arns
}

output "github_actions_release_role_arn" {
  description = "Production GitHub environment release role; null until explicitly enabled."
  value       = module.github_actions_release.release_role_arn
}

output "github_actions_smoke_secret_arn" {
  description = "Deployment verifier secret metadata ARN; populate its value outside Terraform."
  value       = module.github_actions_release.smoke_secret_arn
}
