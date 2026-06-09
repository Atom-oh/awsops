resource "aws_ecs_cluster" "main" {
  name = var.project
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Review Blocker A: ECS `secrets`(valueFrom) is resolved by the EXECUTION role at
# task start — it must read the RDS-managed secret + decrypt with the CMK.
resource "aws_iam_role_policy" "execution_secrets" {
  name = "${var.project}-exec-aurora-secret"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_rds_cluster.aurora.master_user_secret[0].secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.aurora.arn]
      }
    ]
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# F5: read-only CloudWatch metrics + Pricing API for the EC2 page KPI cards
# (평균 CPU via GetMetricData, 시간당 비용 via Pricing GetProducts). Read-only invariant.
resource "aws_iam_role_policy" "task_metrics" {
  name = "${var.project}-task-metrics-read"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics",
        "pricing:GetProducts",
        "pricing:DescribeServices",
      ]
      Resource = "*"
    }]
  })
}

# ADR-031 Phase 1: admin gate (always-on — unlike AgentCore, the admin gate is not feature-flagged).
# Comma-separated admin-email allowlist; managed out-of-band (ignore drift). Empty/blank = cognito:groups-only.
resource "aws_ssm_parameter" "admin_emails" {
  name        = "/ops/${var.project}/admin_emails"
  description = "ADR-031: comma-separated admin email allowlist for custom-agent authoring. Blank = cognito:groups-only."
  type        = "StringList"
  value       = " "
  lifecycle { ignore_changes = [value] }
}

# Web task role reads the admin-email allowlist (web/lib/admin.ts SSMClient.GetParameter). Read-only, single param.
resource "aws_iam_role_policy" "task_admin_ssm" {
  name = "${var.project}-task-admin-ssm"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = [aws_ssm_parameter.admin_emails.arn]
    }]
  })
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.project}-web"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.project}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name         = "web"
      image        = "${aws_ecr_repository.web.repository_url}:${var.image_tag}"
      essential    = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      # concat keeps this byte-identical when workers_enabled=false (concat(base, []) == base →
      # no web task-def revision / redeploy). Enabling workers adds JOBS_QUEUE_URL (W7 producer).
      environment = concat([
        { name = "PORT", value = "3000" },
        # Force Next.js standalone to bind 0.0.0.0. Docker/ECS sets the runtime HOSTNAME to the
        # container hostname (→ ENI IP only), overriding the Dockerfile's ENV HOSTNAME=0.0.0.0,
        # so the app listened on the ENI IP and the 127.0.0.1 container healthcheck probe failed
        # (ALB to the ENI IP still passed). Pinning HOSTNAME here makes loopback reachable.
        { name = "HOSTNAME", value = "0.0.0.0" },
        { name = "AURORA_ENDPOINT", value = aws_rds_cluster.aurora.endpoint },
        { name = "AURORA_DATABASE", value = aws_rds_cluster.aurora.database_name },
        { name = "AWS_REGION", value = var.region },
        { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.main.id },
        { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.main.id },
        { name = "SSM_RUNTIME_ARN_PARAM", value = "/ops/${var.project}/agentcore/runtime_arn" },
        { name = "INV_SYNC_FUNCTION", value = var.steampipe_enabled ? "${var.project}-inv-sync" : "" },
        # P3-D: onboarded-cluster allow-list for the in-cluster (K8s) read routes.
        # Static join of the tfvar (no cross-resource ref) — the BFF gates /api/eks/[cluster]/* on this.
        { name = "ONBOARDED_EKS_CLUSTERS", value = join(",", var.onboard_eks_clusters) },
        # ADR-031 Phase 1: admin gate config (always-on; the page/API 403s non-admins).
        { name = "ADMIN_GROUP", value = "admins" },
        { name = "SSM_ADMIN_EMAILS_PARAM", value = "/ops/${var.project}/admin_emails" },
        ], var.workers_enabled ? [
        { name = "JOBS_QUEUE_URL", value = one(aws_sqs_queue.jobs[*].url) }
      ] : [])
      secrets = [
        { name = "AURORA_USER", valueFrom = "${aws_rds_cluster.aurora.master_user_secret[0].secret_arn}:username::" },
        { name = "AURORA_PASSWORD", valueFrom = "${aws_rds_cluster.aurora.master_user_secret[0].secret_arn}:password::" }
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O - http://127.0.0.1:3000/api/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 40
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "web"
        }
      }
    }
  ])
}

# CloudFront provisions VPC Origin ENIs into a managed SG ("CloudFront-VPCOrigins-Service-SG").
# The ALB allows ONLY that SG on 443 (review #3: dropped the broad VPC-CIDR rule).
data "aws_security_group" "cf_vpc_origin" {
  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

resource "aws_security_group" "alb" {
  name = "${var.project}-alb-sg"
  # description kept verbatim to match the existing SG (AWS SG description is
  # immutable → changing it forces a replace that DependencyViolation-hangs on the
  # attached ALB). The actual hardening (drop the broad VPC-CIDR :443 ingress) is an
  # in-place rule change below. See comment above re: CloudFront VPC Origin SG only.
  description = "Internal ALB - reachable from within the VPC (CloudFront VPC Origin ENIs)"
  vpc_id      = local.vpc_id

  ingress {
    description     = "HTTPS from CloudFront VPC Origin managed SG"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [data.aws_security_group.cf_vpc_origin.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "service" {
  name = "${var.project}-service-sg"
  # description kept verbatim to match the existing SG (immutable → avoids a replace).
  description = "Spine Fargate tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "ALB to Fargate"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_acm_certificate" "alb" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for r in aws_route53_record.cf_validation : r.fqdn]
}

resource "aws_lb" "internal" {
  name               = "${var.project}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.private_subnet_ids
  idle_timeout       = 120
}

resource "aws_lb_target_group" "web" {
  name        = "${var.project}-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    path                = "/api/health"
    matcher             = "200-399"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.alb.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_ecs_service" "web" {
  name            = "${var.project}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}

# Only the target group rename needs a moved block (its name "${var.project}-tg" is
# unchanged, so this is an in-place rename, not a destroy/recreate that would collide
# on the duplicate name). Same-address moves are a hard TF error, so nothing else here.
moved {
  from = aws_lb_target_group.spine
  to   = aws_lb_target_group.web
}
