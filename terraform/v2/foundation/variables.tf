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
  description = "Aurora PostgreSQL engine version (available, Serverless v2 / provisioned mode)"
  default     = "15.10"
}
variable "aurora_min_acu" {
  type    = number
  default = 0.5
}
variable "aurora_max_acu" {
  type    = number
  default = 4
}
