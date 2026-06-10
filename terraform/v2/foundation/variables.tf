variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "project" {
  type    = string
  default = "awsops-v2"
}

variable "domain_name" {
  type        = string
  description = "Public FQDN served by CloudFront, e.g. v2.atomai.click"
}

variable "hosted_zone_name" {
  type        = string
  description = "Route53 public hosted zone, e.g. atomai.click"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "azs" {
  type        = list(string)
  description = "Two AZs for subnets"
  default     = ["ap-northeast-2a", "ap-northeast-2c"]
}

variable "image_tag" {
  type        = string
  description = "Web image tag in ECR"
  default     = "web-latest"
}

variable "allow_vpc_db_access" {
  type    = bool
  default = true
}

variable "create_network" {
  type        = bool
  description = "true=create new VPC/subnets/NAT; false=reuse existing (set existing_* below)"
  default     = true
}

variable "existing_vpc_id" {
  type        = string
  description = "Existing VPC ID to reuse when create_network=false"
  default     = ""
}

variable "existing_private_subnet_ids" {
  type        = list(string)
  description = "Existing private subnets (>=2 AZ, NAT egress) for ALB/Fargate when create_network=false"
  default     = []
}

variable "cognito_domain_prefix" {
  type        = string
  description = "Globally-unique Cognito Hosted-UI domain prefix (no 'aws', no symbols)."
  default     = "awsops-v2-auth"
}

variable "admin_email" {
  type        = string
  description = "Initial Cognito admin user email"
}

variable "admin_password" {
  type        = string
  description = "Initial admin permanent password (>=8, upper+lower+number)"
  sensitive   = true
}

variable "aurora_engine_version" {
  type        = string
  description = "Aurora PostgreSQL engine version (Serverless v2). Exact minor for a deterministic major upgrade; future minor auto-upgrades are absorbed by ignore_changes on the cluster/instance (not by a major-only pin — that mis-fires on aws_rds_cluster)."
  default     = "17.9"
}
variable "aurora_min_acu" {
  type    = number
  default = 0.5
}
variable "aurora_max_acu" {
  type    = number
  default = 4
}

variable "workers_enabled" {
  type        = bool
  description = "P2 async worker backbone gate. false (default) = 0 worker resources/cost. Enable in P2 W9."
  default     = false
}

variable "worker_image_tag" {
  type        = string
  description = "Worker Fargate image tag in the worker ECR repo."
  default     = "worker-latest"
}

variable "remediation_enabled" {
  type        = bool
  description = "ADR-029+036 remediation/mutation substrate gate. false (default) = 0 mutating resources, 0 cost, ZERO live AWS mutation. The always-present catalog/plan/audit tables (migration v4) are harmless when off. Enable ONLY after the catalog + controls are reviewed AND an operator accepts the first mutating capability."
  default     = false
}

variable "hybrid_routing_enabled" {
  type        = bool
  description = "ADR-038 hybrid chat routing gate. false (default) = legacy regex-only routing, no classifier Bedrock calls, no extra IAM. Enable only after the golden-set gate (scripts/v2/routing-accuracy.mjs) passes >=85% and >= +15pp over the regex baseline."
  default     = false
}

variable "incident_lifecycle_enabled" {
  type        = bool
  description = "ADR-032 incident lifecycle gate. false (default) = 0 lifecycle infra, 0 cost, ZERO autonomous triggers. The always-present incident_* tables (migration v5) are harmless when off. REQUIRES workers_enabled=true to enable (reuses the P2 queue/dispatcher/reaper/status_updater/pg8000 layer)."
  default     = false
}

variable "rca_writeback_enabled" {
  type        = bool
  description = "ADR-034 RCA write-back gate (observability-write tier). false (default) = 0 write-back infra, 0 cost, ZERO OpsCenter/Incident-Manager write. The always-present incident_writeback table (migration v6) is harmless when off. REQUIRES incident_lifecycle_enabled=true (adds a stage to the incident SM, reads incidents.rca) AND remediation_enabled=true (reuses the opscenter-create-opsitem catalog action + action_opscenter_write per-action role from remediation.tf). The webhook marker-drop filter is ALWAYS-ON (a harmless safety filter independent of this flag)."
  default     = false
}

variable "steampipe_enabled" {
  type        = bool
  description = "D1 inventory data layer (warm Steampipe Fargate + sync Lambda). false (default) = 0 resources/cost."
  default     = false
}

variable "steampipe_image_tag" {
  type        = string
  description = "Steampipe service image tag."
  default     = "steampipe-latest"
}
