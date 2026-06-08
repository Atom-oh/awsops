# D1 inventory data layer — warm Steampipe Fargate (stateless FDW) + sync Lambda -> Aurora.
# All gated by var.steampipe_enabled (count=local.sp → 0 resources/cost when off).
locals { sp = var.steampipe_enabled ? 1 : 0 }

# ---- Steampipe DB password (network listener auth) ----
resource "random_password" "steampipe" {
  count   = local.sp
  length  = 24
  special = false
}
resource "aws_secretsmanager_secret" "steampipe" {
  count = local.sp
  name  = "${var.project}-steampipe-db"
}
resource "aws_secretsmanager_secret_version" "steampipe" {
  count         = local.sp
  secret_id     = aws_secretsmanager_secret.steampipe[0].id
  secret_string = random_password.steampipe[0].result
}

# ECS resolves the task def `secrets`/valueFrom with the EXECUTION role (not the task role).
# The shared execution_secrets policy only covers the Aurora secret; grant the Steampipe secret
# too or the Steampipe task fails ResourceInitializationError on start. Gated so it stays plan-clean
# when disabled. No kms grant needed — the secret uses the default aws/secretsmanager key.
resource "aws_iam_role_policy" "execution_steampipe_secret" {
  count = local.sp
  name  = "${var.project}-exec-steampipe-secret"
  role  = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.steampipe[0].arn }]
  })
}

# ---- ECR + log groups ----
resource "aws_ecr_repository" "steampipe" {
  count                = local.sp
  name                 = "${var.project}-steampipe"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  force_delete = true
}
resource "aws_cloudwatch_log_group" "steampipe" {
  count             = local.sp
  name              = "/ecs/${var.project}-steampipe"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "inv_sync" {
  count             = local.sp
  name              = "/aws/lambda/${var.project}-inv-sync"
  retention_in_days = 30
}

# ---- Steampipe SG: ingress 9193 from the web service SG only ----
resource "aws_security_group" "steampipe" {
  count       = local.sp
  name        = "${var.project}-steampipe-sg"
  description = "Steampipe FDW - reachable from web/lambda service SG on 9193"
  vpc_id      = local.vpc_id
  ingress {
    description     = "Postgres FDW from service SG"
    from_port       = 9193
    to_port         = 9193
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---- Cloud Map service discovery so the sync Lambda finds Steampipe by DNS ----
resource "aws_service_discovery_private_dns_namespace" "main" {
  count = local.sp
  name  = "${var.project}.internal"
  vpc   = local.vpc_id
}
resource "aws_service_discovery_service" "steampipe" {
  count = local.sp
  name  = "steampipe"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main[0].id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config { failure_threshold = 1 }
}

# ---- Steampipe task role: ec2:Describe* + sts only (D1; expand per wave) ----
resource "aws_iam_role" "steampipe_task" {
  count              = local.sp
  name               = "${var.project}-steampipe-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "steampipe_task" {
  count = local.sp
  name  = "${var.project}-steampipe-read"
  role  = aws_iam_role.steampipe_task[0].id
  # ec2:Describe* covers ec2/vpc/subnet/security_group/ebs. Curated read-only metadata
  # actions per D2 wave (no object data, secrets, or KMS). Resource="*" — these list/describe
  # APIs don't support resource-level scoping. Far narrower than ReadOnlyAccess.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ec2:Describe*", "sts:GetCallerIdentity",
        "s3:ListAllMyBuckets", "s3:GetBucket*", "s3:GetAccountPublicAccessBlock", "s3:GetEncryptionConfiguration",
        "lambda:List*", "lambda:GetFunction*", "lambda:GetPolicy",
        "rds:Describe*", "rds:ListTagsForResource",
        "dynamodb:List*", "dynamodb:Describe*",
        "ecs:List*", "ecs:Describe*",
        "ecr:Describe*", "ecr:List*", "ecr:GetLifecyclePolicy", "ecr:GetRepositoryPolicy",
        "iam:List*", "iam:Get*", "iam:GenerateCredentialReport"
      ]
      Resource = "*"
    }]
  })
}

# ---- Steampipe Fargate service (warm, FARGATE_SPOT) ----
resource "aws_ecs_task_definition" "steampipe" {
  count                    = local.sp
  family                   = "${var.project}-steampipe"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.steampipe_task[0].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "steampipe"
    image        = "${aws_ecr_repository.steampipe[0].repository_url}:${var.steampipe_image_tag}"
    essential    = true
    portMappings = [{ containerPort = 9193, protocol = "tcp" }]
    environment  = [{ name = "AWS_REGION", value = var.region }]
    secrets      = [{ name = "STEAMPIPE_DATABASE_PASSWORD", valueFrom = aws_secretsmanager_secret.steampipe[0].arn }]
    healthCheck = {
      command     = ["CMD-SHELL", "steampipe query \"select 1\" >/dev/null 2>&1 || exit 1"]
      interval    = 30
      timeout     = 10
      retries     = 3
      startPeriod = 90
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.steampipe[0].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "steampipe" }
    }
  }])
}
resource "aws_ecs_service" "steampipe" {
  count           = local.sp
  name            = "${var.project}-steampipe"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.steampipe[0].arn
  desired_count   = 1
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.steampipe[0].id]
    assign_public_ip = false
  }
  service_registries { registry_arn = aws_service_discovery_service.steampipe[0].arn }
}
resource "aws_cloudwatch_metric_alarm" "steampipe_down" {
  count               = local.sp
  alarm_name          = "${var.project}-steampipe-down"
  namespace           = "AWS/ECS"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.steampipe[0].name }
  statistic           = "Average"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 3
}

# ---- sync Lambda (VPC, pg8000 layer; queries Steampipe + writes Aurora) ----
resource "terraform_data" "inv_pg8000_build" {
  count            = local.sp
  triggers_replace = filemd5("${path.module}/../../../scripts/v2/steampipe/requirements.txt")
  provisioner "local-exec" {
    command = <<-EOT
      set -e
      rm -rf ${path.module}/.build/inv_layer
      mkdir -p ${path.module}/.build/inv_layer/python
      python3 -m pip install pg8000==1.31.2 --target ${path.module}/.build/inv_layer/python
    EOT
  }
}
data "archive_file" "inv_layer" {
  count       = local.sp
  type        = "zip"
  source_dir  = "${path.module}/.build/inv_layer"
  output_path = "${path.module}/.build/inv_layer.zip"
  depends_on  = [terraform_data.inv_pg8000_build]
}
resource "aws_lambda_layer_version" "inv_pg8000" {
  count                    = local.sp
  layer_name               = "${var.project}-inv-pg8000"
  filename                 = data.archive_file.inv_layer[0].output_path
  source_code_hash         = data.archive_file.inv_layer[0].output_base64sha256
  compatible_runtimes      = ["python3.12"]
  compatible_architectures = ["arm64"]
}
data "archive_file" "inv_sync_src" {
  count       = local.sp
  type        = "zip"
  output_path = "${path.module}/.build/inv_sync.zip"
  source {
    content  = file("${path.module}/../../../scripts/v2/steampipe/sync_lambda.py")
    filename = "sync_lambda.py"
  }
}
resource "aws_iam_role" "inv_sync" {
  count              = local.sp
  name               = "${var.project}-inv-sync"
  assume_role_policy = data.aws_iam_policy_document.worker_lambda_assume.json
}
resource "aws_iam_role_policy_attachment" "inv_sync_vpc" {
  count      = local.sp
  role       = aws_iam_role.inv_sync[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "inv_sync" {
  count = local.sp
  name  = "${var.project}-inv-sync"
  role  = aws_iam_role.inv_sync[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.steampipe[0].arn, aws_rds_cluster.aurora.master_user_secret[0].secret_arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.aurora.arn },
      # self-invoke for type=all fan-out (async InvocationType=Event per type)
      { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_function.inv_sync[0].arn }
    ]
  })
}
resource "aws_lambda_function" "inv_sync" {
  count            = local.sp
  function_name    = "${var.project}-inv-sync"
  role             = aws_iam_role.inv_sync[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "sync_lambda.lambda_handler"
  filename         = data.archive_file.inv_sync_src[0].output_path
  source_code_hash = data.archive_file.inv_sync_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 512
  layers           = [aws_lambda_layer_version.inv_pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      STEAMPIPE_HOST       = "steampipe.${var.project}.internal"
      STEAMPIPE_SECRET_ARN = aws_secretsmanager_secret.steampipe[0].arn
      AURORA_ENDPOINT      = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE      = aws_rds_cluster.aurora.database_name
      AURORA_SECRET_ARN    = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
    }
  }
  depends_on = [aws_cloudwatch_log_group.inv_sync, aws_iam_role_policy_attachment.inv_sync_vpc]
}

# ---- scheduled sync (EventBridge rate(15m) -> ec2) ----
resource "aws_cloudwatch_event_rule" "inv_sync" {
  count               = local.sp
  name                = "${var.project}-inv-sync-ec2"
  schedule_expression = "rate(15 minutes)"
}
resource "aws_cloudwatch_event_target" "inv_sync" {
  count     = local.sp
  rule      = aws_cloudwatch_event_rule.inv_sync[0].name
  target_id = "inv-sync-ec2"
  arn       = aws_lambda_function.inv_sync[0].arn
  input     = jsonencode({ type = "all" })
}
resource "aws_lambda_permission" "inv_sync_events" {
  count         = local.sp
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.inv_sync[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.inv_sync[0].arn
}

# ---- web task role may invoke the sync Lambda (refresh) ----
resource "aws_iam_role_policy" "task_inv_sync_invoke" {
  count = local.sp
  name  = "${var.project}-task-inv-sync-invoke"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_function.inv_sync[0].arn }]
  })
}

output "inv_sync_function" { value = one(aws_lambda_function.inv_sync[*].function_name) }
output "steampipe_ecr_uri" { value = one(aws_ecr_repository.steampipe[*].repository_url) }
