# Retained, default-off restart for the host web service on its own Aurora master-secret rotation:
# EventBridge(Secrets Manager RotationSucceeded) -> Lambda -> ecs:UpdateService(forceNewDeployment).
# ADR-015 records the historical task-start password-injection failure. The current web BFF uses
# per-connection IAM DB authentication as awsops_web; it no longer injects that master password.
# The historical outage is not a recommendation to enable this feature for the current web service.
# Disabled means no resources for this feature, not a cost-free shared foundation.
#
# POSTURE: ADR-015 is the explicit, dated exception to ADR-005; it is not a separate mutation category.
# Only the own web service may restart, with unchanged image/task definition and fail-closed secret
# matching. IAM scopes UpdateService to one service ARN; Lambda enforces restart-only arguments.
# All other AWS-resource mutation/autonomy remains frozen. The ADR and BASELINE govern this boundary.

variable "secret_rotation_redeploy_enabled" {
  type        = bool
  default     = false
  description = "ADR-015 exception: restart only the host web service on its own Aurora master-secret rotation. Default off; the current web BFF uses IAM DB auth."
}

locals {
  srr = var.secret_rotation_redeploy_enabled ? 1 : 0
  # The list shape does not authorize expansion: ADR-015 permits exactly the host web service.
  srr_services = [aws_ecs_service.web.name]
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
    # Scoped to the web service ARN only. NOTE: this grants full ecs:UpdateService on that ONE
    # service — there is no IAM condition key to restrict it to forceNewDeployment, so
    # "force-new-deployment-only" is enforced by the LAMBDA's behavior, not by IAM. The remaining
    # control is the tight resource scope (one own service) + the Lambda being the only caller.
    # MUST stay in lockstep with local.srr_services (single service today); extend Resource if it grows.
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecs:UpdateService"] # DescribeServices dropped — redeploy.py never calls it
      Resource = aws_ecs_service.web.arn
    }]
  })
}

resource "aws_cloudwatch_log_group" "secret_rotation_redeploy" {
  count             = local.srr
  name              = "/aws/lambda/${var.project}-secret-rotation-redeploy"
  retention_in_days = 30
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
  depends_on       = [aws_cloudwatch_log_group.secret_rotation_redeploy]
  environment {
    variables = {
      CLUSTER  = aws_ecs_cluster.main.name
      SERVICES = join(",", local.srr_services)
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

# M3 — the redeploy.py fail-closed skip paths (unset target, unidentified secret, non-matching
# secret) return normally and only log a WARN; without this, a wrong event-shape assumption fails
# silently and the exact outage this Lambda exists to prevent could recur with zero signal. This
# turns every WARN line into a countable metric + a visible (not yet subscribed — wire an
# alarm_actions SNS/OpsGenie/etc. target per your alerting stack before relying on it) alarm.
resource "aws_cloudwatch_log_metric_filter" "secret_rotation_redeploy_skip" {
  count          = local.srr
  name           = "${var.project}-secret-rotation-redeploy-skip"
  log_group_name = aws_cloudwatch_log_group.secret_rotation_redeploy[0].name
  pattern        = "\"[secret-rotation-redeploy] WARN\""
  metric_transformation {
    name      = "SecretRotationRedeploySkipped"
    namespace = "${var.project}/secret-rotation-redeploy"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "secret_rotation_redeploy_skip" {
  count               = local.srr
  alarm_name          = "${var.project}-secret-rotation-redeploy-skip"
  alarm_description   = "redeploy.py hit a fail-closed skip path (unset target / unidentified secret) — the event-shape assumption may be wrong and the rotation outage this Lambda guards against could go unfixed. Wire alarm_actions before relying on this."
  namespace           = "${var.project}/secret-rotation-redeploy"
  metric_name         = "SecretRotationRedeploySkipped"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
}
