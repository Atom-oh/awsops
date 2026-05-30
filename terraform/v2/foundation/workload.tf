resource "aws_ecr_repository" "spine" {
  name                 = "${var.project}-spine"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true # spine is throwaway; replaced by the real image in P1d
}

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

resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_cloudwatch_log_group" "spine" {
  name              = "/ecs/${var.project}-spine"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "spine" {
  family                   = "${var.project}-spine"
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
      name         = "spine"
      image        = "${aws_ecr_repository.spine.repository_url}:${var.image_tag}"
      essential    = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment  = [{ name = "PORT", value = "3000" }]
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O - http://127.0.0.1:3000/awsops/healthz || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spine.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "spine"
        }
      }
    }
  ])
}

# CloudFront provisions VPC Origin ENIs into a managed security group
# ("CloudFront-VPCOrigins-Service-SG"). The ALB must allow that SG as a source
# on 443 — a VPC-CIDR rule alone is not sufficient for the CloudFront→ALB hop
# (matches the proven AWS-Demo-Platform alb-internal pattern, which gates on
# this SG). Created lazily by CloudFront once a VPC origin exists in the VPC.
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
  name        = "${var.project}-alb-sg"
  description = "Internal ALB - reachable from within the VPC (CloudFront VPC Origin ENIs)"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTPS from within VPC (incl. CloudFront VPC Origin ENIs)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [local.vpc_cidr]
  }
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
  name        = "${var.project}-service-sg"
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

# Regional (ap-northeast-2) ACM cert for the ALB HTTPS listener. CloudFront's
# VPC Origin connects over TLS with SNI = var.domain_name, so the ALB must
# present a cert covering it. Validated via the SAME Route53 CNAMEs the
# CloudFront cert (edge.tf) already created — ACM uses one validation record
# per domain, so no new DNS records and no conflict.
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
}

resource "aws_lb_target_group" "spine" {
  name        = "${var.project}-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    path                = "/awsops/healthz"
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
    target_group_arn = aws_lb_target_group.spine.arn
  }
}

resource "aws_ecs_service" "spine" {
  name            = "${var.project}-spine"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.spine.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.spine.arn
    container_name   = "spine"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}
