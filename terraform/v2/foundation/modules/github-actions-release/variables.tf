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

variable "state_bucket" {
  type        = string
  default     = null
  description = "Existing backend bucket name (metadata only); required when enabled."
  validation {
    condition = var.state_bucket == null ? !var.enabled : (
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket)) &&
      !can(regex("\\.\\.|^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$", var.state_bucket))
    )
    error_message = "state_bucket must be an explicit valid bucket name when enabled, without wildcards, IP addresses or empty labels."
  }
}

variable "state_key" {
  type        = string
  default     = null
  description = "Exact existing backend object key (metadata only); no lock-file/write access."
  validation {
    condition = var.state_key == null ? !var.enabled : (
      can(regex("^[A-Za-z0-9!_./+=,@:-]+$", var.state_key)) && length(var.state_key) <= 1024 &&
      alltrue([for segment in split("/", var.state_key) : !contains(["", ".", ".."], segment)])
    )
    error_message = "state_key must be an explicit nonempty object key when enabled, without IAM wildcards, interpolation, whitespace or ambiguous path segments."
  }
}

variable "migration_secret_arns" {
  type        = list(string)
  default     = []
  nullable    = false
  description = "Explicit existing Aurora master/reader secret ARNs; values never enter Terraform."
  validation {
    condition = (
      (!var.enabled || length(var.migration_secret_arns) > 0) &&
      length(distinct(var.migration_secret_arns)) == length(var.migration_secret_arns) &&
      alltrue([
        for arn in var.migration_secret_arns :
        can(regex("^arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:[A-Za-z0-9/_+=.@!-]+-[A-Za-z0-9]{6}$", arn))
      ])
    )
    error_message = "migration_secret_arns must contain unique complete Secrets Manager ARNs in the configured account/region, without wildcards; at least one is required when enabled."
  }
}
