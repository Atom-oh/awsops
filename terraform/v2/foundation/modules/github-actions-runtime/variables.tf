variable "enabled" {
  type    = bool
  default = false
}
variable "migration_enabled" {
  type        = bool
  default     = false
  description = "Allow building the shared private migration image; does not grant database-secret access."
}
variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "A literal 12-digit account is required."
  }
}
variable "project" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,39}$", var.project))
    error_message = "Project must be a literal lowercase project name."
  }
}
variable "region" {
  type = string
  validation {
    condition     = can(regex("^(af|ap|ca|eu|il|me|mx|sa|us)-(central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$", var.region))
    error_message = "A literal commercial AWS region is required."
  }
}
variable "repository" {
  type = string
  validation {
    condition     = var.repository == "Atom-oh/awsops"
    error_message = "Only Atom-oh/awsops is authorized."
  }
}
variable "environment" {
  type = string
  validation {
    condition     = var.environment == "production"
    error_message = "Only the production environment is authorized."
  }
}
variable "agentcore_role_arn" {
  type    = string
  default = null
  validation {
    condition     = var.agentcore_role_arn == null || var.agentcore_role_arn == "arn:aws:iam::${var.account_id}:role/${var.project}-agentcore"
    error_message = "The AgentCore role must be the existing project role."
  }
}
variable "worker_task_role_arn" {
  type    = string
  default = null
  validation {
    condition     = var.worker_task_role_arn == null || var.worker_task_role_arn == "arn:aws:iam::${var.account_id}:role/${var.project}-worker-task"
    error_message = "The worker role must be the existing project role."
  }
}
variable "execution_role_arn" {
  type    = string
  default = null
  validation {
    condition     = var.execution_role_arn == null || var.execution_role_arn == "arn:aws:iam::${var.account_id}:role/${var.project}-task-execution"
    error_message = "The execution role must be the existing project role."
  }
}
variable "subnets" {
  type    = list(string)
  default = []
  validation {
    condition = (
      (!var.enabled || var.agentcore_role_arn == null || length(var.subnets) > 0) &&
      alltrue([for id in var.subnets : can(regex("^subnet-([0-9a-f]{8}|[0-9a-f]{17})$", id))])
    )
    error_message = "AgentCore creation requires explicit existing subnet IDs."
  }
}
variable "security_groups" {
  type    = list(string)
  default = []
  validation {
    condition = (
      (!var.enabled || var.agentcore_role_arn == null || length(var.security_groups) > 0) &&
      alltrue([for id in var.security_groups : can(regex("^sg-([0-9a-f]{8}|[0-9a-f]{17})$", id))])
    )
    error_message = "AgentCore creation requires explicit existing security-group IDs."
  }
}
variable "secret_arns" {
  type    = list(string)
  default = []
  validation {
    condition = length(distinct(var.secret_arns)) == length(var.secret_arns) && alltrue([
      for arn in var.secret_arns : can(regex("^arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:ops/${var.project}/integrations/credentials-[A-Za-z0-9]{6}$", arn))
    ])
    error_message = "Only the explicit project integration secret is permitted; database secrets belong to the private migration task."
  }
}
variable "secret_kms_key_arns" {
  type    = list(string)
  default = []
  validation {
    condition = (!var.enabled || length(var.secret_kms_key_arns) == 0 || length(var.secret_arns) > 0) && length(distinct(var.secret_kms_key_arns)) == length(var.secret_kms_key_arns) && alltrue([
      for arn in var.secret_kms_key_arns : can(regex("^arn:aws:kms:${var.region}:${var.account_id}:key/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$", arn))
    ])
    error_message = "Only explicit same-account/region KMS key ARNs are permitted."
  }
}
