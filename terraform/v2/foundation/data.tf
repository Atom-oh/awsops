resource "aws_kms_key" "aurora" {
  description             = "${var.project} Aurora storage + master-secret encryption"
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "aurora" {
  name          = "alias/${var.project}-aurora"
  target_key_id = aws_kms_key.aurora.key_id
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.project}-aurora"
  subnet_ids = local.private_subnet_ids
}

resource "aws_security_group" "aurora" {
  name        = "${var.project}-aurora-sg"
  description = "Aurora - app/Fargate + in-VPC migration on 5432"
  vpc_id      = local.vpc_id

  ingress {
    description     = "App/Fargate tasks to Aurora"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  dynamic "ingress" {
    for_each = var.allow_vpc_db_access ? [1] : []
    content {
      description = "In-VPC migration (deploy host) - dev only"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [local.vpc_cidr]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier            = "${var.project}-aurora"
  engine                        = "aurora-postgresql"
  engine_mode                   = "provisioned"
  engine_version                = var.aurora_engine_version
  database_name                 = "awsops"
  master_username               = "awsops_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.aurora.key_id
  storage_encrypted             = true
  kms_key_id                    = aws_kms_key.aurora.arn
  db_subnet_group_name          = aws_db_subnet_group.aurora.name
  vpc_security_group_ids        = [aws_security_group.aurora.id]
  backup_retention_period       = 7
  deletion_protection           = false
  skip_final_snapshot           = true

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.project}-aurora-1"
  cluster_identifier = aws_rds_cluster.aurora.id
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version
  instance_class     = "db.serverless"
}
