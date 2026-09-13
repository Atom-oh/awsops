variable "ci_readiness_enabled" {
  type        = bool
  default     = false
  description = "Provision the deployment verifier application group without an IAM role."
}

# Runtime activation is opt-in. Host inventory retains its all-enabled-region
# scan; global IAM/CloudFront/Route53 endpoints also require us-east-1.
variable "inventory_host_only" {
  type        = bool
  default     = false
  description = "Restrict the inventory collector to its verified host account; omit cross-account AssumeRole."
}

variable "steampipe_image_digest" {
  type        = string
  default     = null
  nullable    = true
  description = "Verified immutable ARM64 inventory image digest; null preserves the legacy image tag."
  validation {
    condition     = var.steampipe_image_digest == null || can(regex("^sha256:[a-f0-9]{64}$", var.steampipe_image_digest))
    error_message = "steampipe_image_digest must be a sha256 digest."
  }
}

variable "worker_image_digest" {
  type        = string
  default     = null
  nullable    = true
  description = "Verified immutable ARM64 worker image digest; null preserves the legacy image tag."
  validation {
    condition     = var.worker_image_digest == null || can(regex("^sha256:[a-f0-9]{64}$", var.worker_image_digest))
    error_message = "worker_image_digest must be a sha256 digest."
  }
}

locals {
  core_runtime_enabled = var.steampipe_enabled || var.agentcore_enabled || var.workers_enabled
}

data "aws_regions" "runtime_read" {
  count       = local.core_runtime_enabled ? 1 : 0
  all_regions = false
}

locals {
  runtime_read_regions = local.core_runtime_enabled ? sort(distinct(concat(
    tolist(data.aws_regions.runtime_read[0].names), [var.region, "us-east-1"]
  ))) : [var.region, "us-east-1"]
  runtime_read_condition = {
    StringEquals = { "aws:RequestedRegion" = local.runtime_read_regions }
  }
  runtime_region_condition = {
    StringEquals = { "aws:RequestedRegion" = var.region }
  }
  runtime_model_resources = [
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
    "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic.claude-*",
    "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
  ]
}
