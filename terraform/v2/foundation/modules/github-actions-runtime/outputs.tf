output "role_arn" {
  value = one(aws_iam_role.runtime[*].arn)
}
