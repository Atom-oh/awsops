resource "aws_cognito_user_pool" "main" {
  name                     = "${var.project}-pool"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]
  mfa_configuration        = "OFF"

  password_policy {
    minimum_length    = 8
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_pool_client" "main" {
  name                                 = "${var.project}-client"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = true
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  callback_urls                        = ["https://${var.domain_name}/_callback"]
  logout_urls                          = ["https://${var.domain_name}/"]
}

resource "aws_cognito_user" "admin" {
  user_pool_id = aws_cognito_user_pool.main.id
  username     = var.admin_email
  password     = var.admin_password
  attributes = {
    email          = var.admin_email
    email_verified = true
  }
}
