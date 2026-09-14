output "release_role_arn" {
  description = "Role for the exact origin production GitHub environment; null when disabled."
  value       = one(aws_iam_role.release[*].arn)
}

output "smoke_secret_arn" {
  description = "Metadata-only deployment verifier secret ARN; null when disabled."
  value       = one(aws_secretsmanager_secret.verifier[*].arn)
}
