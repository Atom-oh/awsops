# Auto-redeploy services that inject the Aurora master secret via ECS secrets/valueFrom (the web
# BFF) when that secret ROTATES. RDS manages + rotates the master password (default every 7 days);
# a long-running task keeps the password injected at start, so after a rotation Aurora auth fails
# (`password authentication failed for user "awsops_admin"`) until the task restarts. This wires
# EventBridge(Secrets Manager RotationSucceeded) -> Lambda -> ecs:UpdateService force-new-deployment.
# Gated; default false -> 0 resources / $0. Worker/sync LAMBDAS are unaffected (they fetch the
# secret per invocation), so only valueFrom-at-start services need this.
#
# POSTURE — ratified by ADR-015 (operational self-healing; see docs/decisions/015-* + BASELINE §2).
# This triggers an automatic `ecs:UpdateService --force-new-deployment` on the host's OWN web service
# to recover from Aurora master-secret rotation. ADR-015 scopes this as a category DISTINCT from the
# ADR-005 frozen mutation/autonomy substrate (which stays frozen): own-service-only, force-new-
# deployment-only, IAM scoped to one service ARN, secret-id fail-closed, default-off. NOT AWS-resource
# mutation of managed/customer infra. (The governance record is the ADR, not this comment.)

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
    # Scoped to the web service ARN only — force-new-deployment, no other ECS mutation. NOTE: this
    # MUST stay in lockstep with local.srr_services (single service today). If srr_services grows
    # (e.g. steampipe), extend this Resource to those service ARNs or the extra ones get AccessDenied.
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
  architectures    = ["arm64"] # repo convention (all v2 Lambdas are arm64)
  handler          = "redeploy.handler"
  filename         = data.archive_file.secret_rotation_redeploy[0].output_path
  source_code_hash = data.archive_file.secret_rotation_redeploy[0].output_base64sha256
  timeout          = 30
  memory_size      = 128
  environment {
    variables = {
      CLUSTER  = aws_ecs_cluster.main.name
      SERVICES = local.srr_services
      # the handler re-checks the rotated secret id against this before redeploying, so the
      # EventBridge rule can match RotationSucceeded broadly (M2 — secret-id event path varies).
      AURORA_SECRET_ARN = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
    }
  }
}

# Secrets Manager RotationSucceeded → redeploy. We match the event BROADLY (any RotationSucceeded)
# and let the Lambda confirm the secret id == AURORA_SECRET_ARN, because the secret id arrives under
# different keys across event shapes (additionalEventData.SecretId / serviceEventDetails.secretId /
# requestParameters.secretId) — over-constraining the pattern risks a silent miss (M2).
#
# ⚠️ DEPENDENCY (M1): EventBridge only receives `RotationSucceeded` when a CloudTrail trail logging
# management events exists in this account+region (Secrets Manager has NO native non-CloudTrail
# rotation event). The org/account is expected to have one (the v2 agent reads CloudTrail). If no
# trail exists, this rule never fires and the rotation outage recurs — create/verify a trail before
# enabling. Not auto-created here (a trail is shared account-wide infra, owned elsewhere).
resource "aws_cloudwatch_event_rule" "aurora_secret_rotated" {
  count       = local.srr
  name        = "${var.project}-aurora-secret-rotated"
  description = "Secrets Manager RotationSucceeded -> redeploy valueFrom-at-start services (Lambda filters by secret id)"
  event_pattern = jsonencode({
    source        = ["aws.secretsmanager"]
    "detail-type" = ["AWS Service Event via CloudTrail", "AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["secretsmanager.amazonaws.com"]
      eventName   = ["RotationSucceeded"]
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
