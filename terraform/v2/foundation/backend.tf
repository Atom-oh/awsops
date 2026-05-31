terraform {
  required_version = ">= 1.15"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
  # Partial backend: OSS-portable, no hardcoded bucket. Config supplied at
  # init time via `-backend-config=backend.hcl`.
  backend "s3" {}
}
