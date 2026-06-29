# Auto-redeploy services that inject the Aurora master secret via ECS secrets/valueFrom (the web
# BFF) when that secret ROTATES. RDS manages + rotates the master password (default every 7 days);
# a long-running task keeps the password injected at start, so after a rotation Aurora auth fails
# (`password authentication failed for user "awsops_admin"`) until the task restarts. This wires
# EventBridge(Secrets Manager RotationSucceeded) -> Lambda -> ecs:UpdateService force-new-deployment.
# Gated; default false -> 0 resources / $0. Worker/sync LAMBDAS are unaffected (they fetch the
# secret per invocation), so only valueFrom-at-start services need this.

variable "secret_rotation_redeploy_enabled" {
  type        = bool
  default     = false
  description = "Redeploy valueFrom-at-start services (web) when the Aurora master secret rotates, so they pick up the new password. false (default) = 0 resources, $0."
}

locals {
  srr = var.secret_rotation_redeploy_enabled ? 1 : 0
  # services that inject the Aurora master secret at task start (web today; steampipe joins when
  # the multi-account inventory fan-out PR lands and gives the steampipe task AURORA_SECRET).
  srr_services = aws_ecs_service.web.name
}

data "archive_file" "secret_rotation_redeploy" {
  count       = local.srr
  type        = "zip"
  output_path = "${path.module}/.build/secret_rotation_redeploy.zip"
  source {
    content  = file("${path.root}/../../../scripts/v2/secret-rotation/redeploy.py")
    filename = "redeploy.py"
  }
}

resource "aws_iam_role" "secret_rotation_redeploy" {
  count = local.srr
  name  = "${var.project}-secret-rotation-redeploy"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "secret_rotation_redeploy_logs" {
  count      = local.srr
  role       = aws_iam_role.secret_rotation_redeploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "secret_rotation_redeploy" {
  count = local.srr
  name  = "${var.project}-secret-rotation-redeploy"
  role  = aws_iam_role.secret_rotation_redeploy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    # Scoped to the specific web service ARN — force-new-deployment only, no other ECS mutation.
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
      Resource = aws_ecs_service.web.id
    }]
  })
}

resource "aws_lambda_function" "secret_rotation_redeploy" {
  count            = local.srr
  function_name    = "${var.project}-secret-rotation-redeploy"
  role             = aws_iam_role.secret_rotation_redeploy[0].arn
  runtime          = "python3.12"
  handler          = "redeploy.handler"
  filename         = data.archive_file.secret_rotation_redeploy[0].output_path
  source_code_hash = data.archive_file.secret_rotation_redeploy[0].output_base64sha256
  timeout          = 30
  memory_size      = 128
  environment {
    variables = {
      CLUSTER  = aws_ecs_cluster.main.name
      SERVICES = local.srr_services
    }
  }
}

# Secrets Manager RotationSucceeded for the Aurora master secret (via CloudTrail). Both detail-types
# are matched for robustness; additionalEventData.SecretId scopes it to the Aurora secret only.
resource "aws_cloudwatch_event_rule" "aurora_secret_rotated" {
  count       = local.srr
  name        = "${var.project}-aurora-secret-rotated"
  description = "Aurora master secret rotation -> redeploy valueFrom-at-start services"
  event_pattern = jsonencode({
    source        = ["aws.secretsmanager"]
    "detail-type" = ["AWS Service Event via CloudTrail", "AWS API Call via CloudTrail"]
    detail = {
      eventSource         = ["secretsmanager.amazonaws.com"]
      eventName           = ["RotationSucceeded"]
      additionalEventData = { SecretId = [aws_rds_cluster.aurora.master_user_secret[0].secret_arn] }
    }
  })
}

resource "aws_cloudwatch_event_target" "aurora_secret_rotated" {
  count = local.srr
  rule  = aws_cloudwatch_event_rule.aurora_secret_rotated[0].name
  arn   = aws_lambda_function.secret_rotation_redeploy[0].arn
}

resource "aws_lambda_permission" "secret_rotation_redeploy_events" {
  count         = local.srr
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.secret_rotation_redeploy[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.aurora_secret_rotated[0].arn
}
