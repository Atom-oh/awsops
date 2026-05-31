output "cloudfront_domain" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "public_url" {
  value = "https://${var.domain_name}"
}

output "alb_arn" {
  value = aws_lb.internal.arn
}

output "ecr_uri" {
  value = aws_ecr_repository.spine.repository_url
}

output "cognito_user_pool_id" { value = aws_cognito_user_pool.main.id }
output "cognito_client_id" { value = aws_cognito_user_pool_client.main.id }
output "cognito_hosted_ui" { value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com" }
