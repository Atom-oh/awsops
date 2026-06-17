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
  value = aws_ecr_repository.web.repository_url
}

output "cognito_user_pool_id" { value = aws_cognito_user_pool.main.id }
output "cognito_client_id" { value = aws_cognito_user_pool_client.main.id }
output "cognito_hosted_ui" { value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com" }

output "aurora_endpoint" { value = aws_rds_cluster.aurora.endpoint }
output "aurora_database" { value = aws_rds_cluster.aurora.database_name }
output "aurora_secret_arn" { value = aws_rds_cluster.aurora.master_user_secret[0].secret_arn }

output "ecr_web_uri" { value = aws_ecr_repository.web.repository_url }
output "ecr_public_uri" { value = aws_ecrpublic_repository.web.repository_uri }

output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "ecs_service_name" { value = aws_ecs_service.web.name }
