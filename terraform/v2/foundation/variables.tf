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
  description = "Spine image tag in ECR"
  default     = "spine-latest"
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
