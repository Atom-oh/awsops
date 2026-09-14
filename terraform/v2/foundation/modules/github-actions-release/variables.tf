variable "enabled" {
  type        = bool
  default     = false
  nullable    = false
  description = "Opt in to operator-authorized GitHub Actions web releases."
}

variable "account_id" {
  type        = string
  nullable    = false
  description = "Account owning the existing OIDC provider and release resources."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be an explicit 12-digit AWS account ID."
  }
}

variable "project" {
  type        = string
  nullable    = false
  description = "Existing foundation project; selects only this project's web resources."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,39}$", var.project))
    error_message = "project must be 2-40 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "region" {
  type        = string
  nullable    = false
  description = "Commercial AWS region of the web service, repository and secrets."
  validation {
    condition     = can(regex("^(af|ap|ca|eu|il|me|mx|sa|us)-(central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$", var.region))
    error_message = "region must be a commercial AWS region name; wildcard, GovCloud and China regions are not supported."
  }
}

variable "repository" {
  type        = string
  nullable    = false
  description = "Only the origin repository is authorized by this module."
  validation {
    condition     = var.repository == "Atom-oh/awsops"
    error_message = "repository must be exactly Atom-oh/awsops."
  }
}

variable "environment" {
  type        = string
  nullable    = false
  description = "Only the production GitHub environment is authorized."
  validation {
    condition     = var.environment == "production"
    error_message = "environment must be exactly production, not a branch, tag or pattern."
  }
}

variable "migration_secret_arns" {
  type        = list(string)
  default     = []
  nullable    = false
  description = "Optional existing Aurora master/reader secret ARNs for an identified private migration executor; no values."
  validation {
    condition = (
      length(distinct(var.migration_secret_arns)) == length(var.migration_secret_arns) &&
      alltrue([
        for arn in var.migration_secret_arns :
        can(regex("^arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:[A-Za-z0-9/_+=.@!-]+-[A-Za-z0-9]{6}$", arn))
      ])
    )
    error_message = "migration_secret_arns must be empty or contain unique complete Secrets Manager ARNs in the configured account/region, without wildcards."
  }
}

variable "secret_kms_key_arns" {
  type        = list(string)
  default     = []
  nullable    = false
  description = "Optional existing customer-managed keys for approved release secrets; complete key ARNs only."
  validation {
    condition = (
      length(distinct(var.secret_kms_key_arns)) == length(var.secret_kms_key_arns) &&
      alltrue([
        for arn in var.secret_kms_key_arns :
        can(regex("^arn:aws:kms:${var.region}:${var.account_id}:key/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$", arn))
      ])
    )
    error_message = "secret_kms_key_arns must contain unique full KMS key ARNs in the configured account and region; aliases, bare IDs, wildcards and malformed IDs are not allowed."
  }
}
