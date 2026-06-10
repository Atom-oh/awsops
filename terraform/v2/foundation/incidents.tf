# terraform/v2/foundation/incidents.tf
# AWSops v2 ADR-032 — autonomous incident LIFECYCLE substrate.
# EVERY resource here is gated by var.incident_lifecycle_enabled (default false → count=0 → ZERO
# AWS resources, ZERO cost, ZERO autonomous trigger). The always-present incident_* domain tables
# (migration v5) are harmless when off — empty and inert. This EXTENDS the P2 backbone (workers.tf):
# it REUSES the SQS jobs queue, the dispatcher, the reaper, the reused P2 status_updater (the
# failure path's job terminalizer), the pg8000 Lambda layer, and the shared service SG. It adds ONE
# sibling Step Functions machine (incident), the seven incident stage Lambdas, a per-stage timeout
# watchdog (rate-1m EventBridge), and the five configurable storm-cap / window SSM params.
#
# REQUIRES workers_enabled=true: the pg8000 layer (aws_lambda_layer_version.pg8000[0]) and the
# service SG (aws_security_group.service) are provisioned only when workers are on — exactly as
# remediation.tf documents. variables.tf states the same precondition.
#
# SAFETY (autonomous lifecycle shipped OFF): the Lead DELEGATES ONLY; the Sub-agents are
# recommendation-only; NO Lambda or SM state here performs an AWS mutation / runTask / remediation
# call. The incident SM role carries lambda:InvokeFunction on the incident Lambdas (+ the reused
# status_updater) ONLY — NO ecs:*, NO states:StartExecution (the dispatcher starts the SM), NO
# mutating actions. The incident-Lambda role is least-privilege: Aurora secret + KMS + AgentCore
# InvokeAgentRuntime + ssm:GetParameter on the incident/agentcore params + logs + VPC ENI ONLY.
# Design refs: ADR-032 (Addenda #4 configurable windows, #5 least-priv, #6 isolation, #7 storm caps).

locals {
  il             = var.incident_lifecycle_enabled ? 1 : 0
  inc_src        = "${path.module}/../../../scripts/v2/incident"
  workers_src_il = "${path.module}/../../../scripts/v2/workers" # reuse db.py + status_updater ARN
  inc_acct       = data.aws_caller_identity.current.account_id
  # The AgentCore runtime ARN SSM param — created by ai.tf when agentcore_enabled, written by
  # provision.py after apply. Referenced by NAME (string), NOT the gated resource, so the incident
  # slice is independent of agentcore_enabled. agent_bridge.py reads it at runtime (TTL-cached).
  inc_runtime_arn_param = "/ops/${var.project}/agentcore/runtime_arn"
}

############################################################
# Step 1: Configurable storm-cap / window SSM params (Addendum #4/#7 — NOT hardcoded).
#   ignore_changes on value (operator-tunable; the Lambdas read the live value with safe fallbacks).
#   Suffixes match scripts/v2/incident/lifecycle.py _CAP_PARAMS and web/lib/incident.ts byte-for-byte.
############################################################
resource "aws_ssm_parameter" "incident_correlation_window" {
  count       = local.il
  name        = "/ops/${var.project}/incident/correlation-window-minutes"
  description = "ADR-032 #4: dedup look-back window (minutes). Operator-tunable; ignore drift."
  type        = "String"
  value       = "20"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_stage_timeout" {
  count       = local.il
  name        = "/ops/${var.project}/incident/stage-timeout-seconds"
  description = "ADR-032 #4: per-stage watchdog timeout (seconds). Snapshotted onto each incident_stages row. Operator-tunable; ignore drift."
  type        = "String"
  value       = "600"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_max_concurrent" {
  count       = local.il
  name        = "/ops/${var.project}/incident/max-concurrent-investigations"
  description = "ADR-032 #7 storm cap: max concurrent in-flight investigations. Operator-tunable; ignore drift."
  type        = "String"
  value       = "5"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_fanout_max" {
  count       = local.il
  name        = "/ops/${var.project}/incident/subagent-fanout-max"
  description = "ADR-032 #7 storm cap: max Sub-agent fan-out per incident (the SM Map MaxConcurrency). Operator-tunable; ignore drift."
  type        = "String"
  value       = "4"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_min_severity" {
  count       = local.il
  name        = "/ops/${var.project}/incident/min-severity"
  description = "ADR-032 #7 severity gate: drop alerts below this severity before any write (info|warning|critical). Operator-tunable; ignore drift."
  type        = "String"
  value       = "warning"
  lifecycle { ignore_changes = [value] }
}

############################################################
# Step 2: Lambda packaging (one zip: shared workers/db.py + all incident/*.py) + the two IAM roles.
############################################################
data "archive_file" "incident_src" {
  count       = local.il
  type        = "zip"
  output_path = "${path.module}/.build/incident_src.zip"
  source {
    content  = file("${local.workers_src_il}/db.py") # shared Aurora pg8000 connector
    filename = "db.py"
  }
  source {
    content  = file("${local.inc_src}/correlation.py")
    filename = "correlation.py"
  }
  source {
    content  = file("${local.inc_src}/lifecycle.py")
    filename = "lifecycle.py"
  }
  source {
    content  = file("${local.inc_src}/agent_bridge.py")
    filename = "agent_bridge.py"
  }
  source {
    content  = file("${local.inc_src}/triage.py")
    filename = "triage.py"
  }
  source {
    content  = file("${local.inc_src}/lead.py")
    filename = "lead.py"
  }
  source {
    content  = file("${local.inc_src}/subagent.py")
    filename = "subagent.py"
  }
  source {
    content  = file("${local.inc_src}/rootcause.py")
    filename = "rootcause.py"
  }
  source {
    content  = file("${local.inc_src}/mitigation_plan.py")
    filename = "mitigation_plan.py"
  }
  source {
    content  = file("${local.inc_src}/prevention.py")
    filename = "prevention.py"
  }
  source {
    content  = file("${local.inc_src}/incident_stage_failed.py")
    filename = "incident_stage_failed.py"
  }
  source {
    content  = file("${local.inc_src}/incident_watchdog.py")
    filename = "incident_watchdog.py"
  }
}

# ---- incident-Lambda role: VPC ENI + Aurora secret + KMS + AgentCore invoke + scoped SSM reads ----
# Least-privilege (Addendum #5): NO ecs:*, NO mutating actions, NO states:StartExecution. The
# dispatcher starts the SM; the SM invokes these Lambdas.
resource "aws_iam_role" "incident_lambda" {
  count              = local.il
  name               = "${var.project}-incident-lambda"
  assume_role_policy = data.aws_iam_policy_document.worker_lambda_assume.json # reuse (workers.tf)
}

resource "aws_iam_role_policy_attachment" "incident_lambda_vpc" {
  count      = local.il
  role       = aws_iam_role.incident_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "incident_lambda" {
  count = local.il
  name  = "${var.project}-incident-lambda"
  role  = aws_iam_role.incident_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.inc_acct}:*"
      },
      {
        Sid      = "AuroraSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      },
      {
        Sid      = "AuroraKms"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.aurora.arn
      },
      {
        # AgentCore Runtime invoke for the read-only Sub-agent consults (agent_bridge.py). Scoped to
        # the project's AgentCore runtimes in this account/region (the concrete runtime ARN is
        # written to SSM by provision.py post-apply; bedrock-agentcore runtime ARNs are not known at
        # plan time, so scope by account/region + the project name segment). Read-only consult only.
        Sid      = "InvokeAgentRuntime"
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = "arn:aws:bedrock-agentcore:${var.region}:${local.inc_acct}:runtime/${var.project}*"
      },
      {
        # The Lambdas derive SSM paths from PROJECT (/ops/<project>/incident/*) and read the
        # AgentCore runtime-ARN param. Scoped to exactly those parameter ARNs.
        Sid    = "ReadIncidentAndRuntimeParams"
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          aws_ssm_parameter.incident_correlation_window[0].arn,
          aws_ssm_parameter.incident_stage_timeout[0].arn,
          aws_ssm_parameter.incident_max_concurrent[0].arn,
          aws_ssm_parameter.incident_fanout_max[0].arn,
          aws_ssm_parameter.incident_min_severity[0].arn,
          "arn:aws:ssm:${var.region}:${local.inc_acct}:parameter${local.inc_runtime_arn_param}",
        ]
      }
    ]
  })
}

# ---- incident SM role: lambda:InvokeFunction on the 7 incident Lambdas + the reused
#      status_updater + SfnLogging ONLY. NO ecs:*, NO states:StartExecution, NO mutation. ----
resource "aws_iam_role" "incident_sfn" {
  count = local.il
  name  = "${var.project}-incident-sfn"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "incident_sfn" {
  count = local.il
  name  = "${var.project}-incident-sfn"
  role  = aws_iam_role.incident_sfn[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "InvokeIncidentLambdas", Effect = "Allow", Action = ["lambda:InvokeFunction"],
      Resource = [
        aws_lambda_function.incident_triage[0].arn,
        aws_lambda_function.incident_lead[0].arn,
        aws_lambda_function.incident_subagent[0].arn,
        aws_lambda_function.incident_rootcause[0].arn,
        aws_lambda_function.incident_mitigation_plan[0].arn,
        aws_lambda_function.incident_prevention[0].arn,
        aws_lambda_function.incident_stage_failed[0].arn,
        aws_lambda_function.status_updater[0].arn, # reused P2 terminalizer (failure path)
    ] },
  { Sid = "SfnLogging", Effect = "Allow", Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"], Resource = "*" }] })
}

############################################################
# Step 3: CloudWatch log groups (each Lambda + the SM).
############################################################
resource "aws_cloudwatch_log_group" "incident_lambdas" {
  count             = local.il
  name              = "/aws/lambda/${var.project}-incident"
  retention_in_days = 90 # incident audit
}
resource "aws_cloudwatch_log_group" "incident_watchdog" {
  count             = local.il
  name              = "/aws/lambda/${var.project}-incident-watchdog"
  retention_in_days = 90
}
resource "aws_cloudwatch_log_group" "incident_sfn" {
  count             = local.il
  name              = "/aws/vendedlogs/states/${var.project}-incident"
  retention_in_days = 90
}

############################################################
# Step 3 (cont.): the seven incident stage Lambdas (arm64, python3.12, pg8000 layer, VPC for Aurora).
#   Each handler is "<mod>.lambda_handler". Env: Aurora connection (db.py) + PROJECT (the Lambdas
#   derive the incident SSM paths from it) + the five SSM param names + the AgentCore runtime-ARN
#   param (agent_bridge.py reads SSM_RUNTIME_ARN_PARAM). NO mutation surface in any of these.
############################################################
locals {
  inc_env = local.il == 1 ? {
    AURORA_ENDPOINT   = aws_rds_cluster.aurora.endpoint
    AURORA_DATABASE   = aws_rds_cluster.aurora.database_name
    AURORA_SECRET_ARN = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
    PROJECT           = var.project # lifecycle.py derives /ops/<PROJECT>/incident/<suffix>
    # The five configurable-window SSM param NAMES (Addendum #4/#7). The Lambdas read the live
    # values (with safe fallbacks); these names document the contract + keep web/python aligned.
    INCIDENT_CORRELATION_WINDOW_PARAM = aws_ssm_parameter.incident_correlation_window[0].name
    INCIDENT_STAGE_TIMEOUT_PARAM      = aws_ssm_parameter.incident_stage_timeout[0].name
    INCIDENT_MAX_CONCURRENT_PARAM     = aws_ssm_parameter.incident_max_concurrent[0].name
    INCIDENT_FANOUT_MAX_PARAM         = aws_ssm_parameter.incident_fanout_max[0].name
    INCIDENT_MIN_SEVERITY_PARAM       = aws_ssm_parameter.incident_min_severity[0].name
    # AgentCore runtime-ARN SSM param (read-only Sub-agent consult bridge). agent_bridge.py reads
    # SSM_RUNTIME_ARN_PARAM; AGENTCORE_RUNTIME_ARN_PARAM is the plan-named alias (same value).
    SSM_RUNTIME_ARN_PARAM       = local.inc_runtime_arn_param
    AGENTCORE_RUNTIME_ARN_PARAM = local.inc_runtime_arn_param
  } : {}
}

resource "aws_lambda_function" "incident_triage" {
  count            = local.il
  function_name    = "${var.project}-incident-triage"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "triage.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_lead" {
  count            = local.il
  function_name    = "${var.project}-incident-lead"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "lead.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_subagent" {
  count            = local.il
  function_name    = "${var.project}-incident-subagent"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "subagent.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_rootcause" {
  count            = local.il
  function_name    = "${var.project}-incident-rootcause"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "rootcause.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_mitigation_plan" {
  count            = local.il
  function_name    = "${var.project}-incident-mitigation-plan"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "mitigation_plan.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_prevention" {
  count            = local.il
  function_name    = "${var.project}-incident-prevention"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "prevention.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_stage_failed" {
  count            = local.il
  function_name    = "${var.project}-incident-stage-failed"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "incident_stage_failed.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 60
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

############################################################
# Step 4: The incident SM (sibling STANDARD machine; T6 ASL) + the per-stage timeout watchdog.
############################################################
resource "aws_sfn_state_machine" "incident" {
  count    = local.il
  name     = "${var.project}-incident"
  role_arn = aws_iam_role.incident_sfn[0].arn
  type     = "STANDARD"
  definition = templatefile("${local.inc_src}/incident.asl.json", {
    triage_fn_arn                = aws_lambda_function.incident_triage[0].arn
    lead_fn_arn                  = aws_lambda_function.incident_lead[0].arn
    subagent_fn_arn              = aws_lambda_function.incident_subagent[0].arn
    rootcause_fn_arn             = aws_lambda_function.incident_rootcause[0].arn
    mitigation_fn_arn            = aws_lambda_function.incident_mitigation_plan[0].arn
    prevention_fn_arn            = aws_lambda_function.incident_prevention[0].arn
    incident_stage_failed_fn_arn = aws_lambda_function.incident_stage_failed[0].arn
    status_fn_arn                = aws_lambda_function.status_updater[0].arn # reused P2 terminalizer
  })
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.incident_sfn[0].arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
  depends_on = [aws_iam_role_policy.incident_sfn]
}

# Per-stage timeout watchdog: flips stuck 'running' stages → 'stalled' (binding (b)/(d)). EventBridge
# rate(1 minute). The rule fires ONLY when the lifecycle flag is on (count=local.il) → no autonomous
# tick when off. The watchdog never cancels SFN / mutates AWS — two bounded conditional UPDATEs.
resource "aws_lambda_function" "incident_watchdog" {
  count            = local.il
  function_name    = "${var.project}-incident-watchdog"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "incident_watchdog.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_watchdog, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_cloudwatch_event_rule" "incident_watchdog" {
  count               = local.il
  name                = "${var.project}-incident-watchdog"
  description         = "ADR-032: per-stage timeout reaper — flips stale 'running' incident_stages to 'stalled'."
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "incident_watchdog" {
  count     = local.il
  rule      = aws_cloudwatch_event_rule.incident_watchdog[0].name
  target_id = "incident-watchdog"
  arn       = aws_lambda_function.incident_watchdog[0].arn
}

resource "aws_lambda_permission" "incident_watchdog" {
  count         = local.il
  statement_id  = "AllowEventBridgeWatchdog"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.incident_watchdog[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.incident_watchdog[0].arn
}

############################################################
# Step 5: Gated output (mirror workers/remediation one(...) style).
############################################################
output "incident_state_machine_arn" { value = one(aws_sfn_state_machine.incident[*].arn) }
