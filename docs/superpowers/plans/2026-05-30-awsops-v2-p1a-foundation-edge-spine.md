# AWSops v2 — P1a: Terraform Foundation + Private Edge + Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the v2 infrastructure spine — a brand-new VPC reachable only through a fully-private edge (CloudFront → VPC Origin → **internal** ALB → ECS Fargate) — and prove it serves both a health endpoint and an SSE stream end-to-end, all via Terraform with remote state.

**Architecture:** A `bootstrap` root module creates the S3 + DynamoDB remote-state backend. A `foundation` root module then builds the network (VPC/subnets/NAT), a throwaway "spine" Fargate service (a ~40-line Node SSE/health server), an **internal** ALB, and a CloudFront distribution that reaches the internal ALB via a **VPC Origin** (no internet-facing load balancer, no CloudFront prefix-list hack). The spine container exists only to validate the edge path and is replaced by the real Next.js image in P1d.

**Tech Stack:** Terraform `~> 1.9`, AWS provider `~> 5.80` (CloudFront VPC origins require `>= 5.73`), ECS Fargate (ARM64), CloudFront, ACM (us-east-1), Route53, Node 20 (spine container), Docker buildx (linux/arm64).

**Out of scope (later sub-plans):** Cognito/Lambda@Edge auth (P1b), Aurora (P1c), CI/CD + real app image (P1d), `make configure` TUI + EKS module (P1e), AgentCore provisioner (P1f). P1a deploys the spine **without auth** — it is intentionally public for the duration of P1a and is locked down in P1b before any real data is served.

---

## Prerequisites

Confirm before starting (these are environmental facts, not steps to build):

- AWS credentials for the **host account** with admin-equivalent rights to create VPC/ECS/CloudFront/ACM/Route53/S3/DynamoDB/ECR/IAM.
- Terraform `>= 1.9` and Docker with `buildx` installed locally.
- An existing Route53 **public hosted zone** for the parent domain (`atomai.click`). Verify:
  ```bash
  aws route53 list-hosted-zones-by-name --dns-name atomai.click \
    --query "HostedZones[0].{Name:Name,Id:Id}" --output table
  ```
  Expected: a row showing `atomai.click.` and a `/hostedzone/ZXXXX` Id.
- The v2 subdomain is **`v2.atomai.click`** (distinct from v1 `awsops.*` and dev `awsops-dev.atomai.click`). It must NOT already resolve:
  ```bash
  dig +short v2.atomai.click
  ```
  Expected: empty output.
- Region: `ap-northeast-2` (primary). CloudFront ACM cert lives in `us-east-1`.
- VPC CIDR `10.20.0.0/16` is chosen to avoid overlap with v1. If v1 already uses `10.20.0.0/16`, change `var.vpc_cidr` consistently in Task 3.

---

## File Structure

```
terraform/v2/
  bootstrap/
    main.tf            # S3 state bucket + DynamoDB lock table (local state)
    variables.tf       # region, project, bucket/table names
    outputs.tf         # bucket name, table name (fed into foundation/backend.tf)
  foundation/
    backend.tf         # s3 backend (points at bootstrap outputs)
    providers.tf       # aws (ap-northeast-2) + aws.use1 (us-east-1) alias
    variables.tf       # domain, vpc_cidr, azs, image_tag, etc.
    network.tf         # VPC, 2x public + 2x private subnets, IGW, NAT, routes
    workload.tf        # ECR repo, ECS cluster, task def (spine), internal ALB, TG, service, SGs
    edge.tf            # ACM (us-east-1) + DNS validation, CloudFront VPC Origin, distribution, Route53 alias
    outputs.tf         # cloudfront domain, alb arn, ecr uri, distribution id, etc.
    terraform.tfvars.example
spine/
  server.js            # ~40-line Node http server: /awsops/healthz + /awsops/api/stream (SSE)
  Dockerfile           # node:20-alpine, arm64
```

Each file has one responsibility: `network.tf` owns connectivity, `workload.tf` owns compute+LB, `edge.tf` owns the CloudFront/ACM/DNS edge. They share one Terraform state (the spine is a single deployable unit); later sub-plans (Aurora, AI) get their own root modules + state keys under `terraform/v2/`.

---

## Task 1: Remote-state backend (bootstrap module)

**Files:**
- Create: `terraform/v2/bootstrap/main.tf`
- Create: `terraform/v2/bootstrap/variables.tf`
- Create: `terraform/v2/bootstrap/outputs.tf`

- [ ] **Step 1: Write `variables.tf`**

```hcl
variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "project" {
  type    = string
  default = "awsops-v2"
}

variable "state_bucket_name" {
  type        = string
  description = "Globally-unique S3 bucket for Terraform state. Override per account."
  default     = "awsops-v2-tfstate"
}

variable "lock_table_name" {
  type    = string
  default = "awsops-v2-tflock"
}
```

- [ ] **Step 2: Write `main.tf`**

```hcl
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Module    = "bootstrap"
    }
  }
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "lock" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute {
    name = "LockID"
    type = "S"
  }
}
```

- [ ] **Step 3: Write `outputs.tf`**

```hcl
output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "lock_table" {
  value = aws_dynamodb_table.lock.name
}
```

- [ ] **Step 4: Init + validate**

Run:
```bash
cd terraform/v2/bootstrap && terraform init && terraform fmt && terraform validate
```
Expected: `Success! The configuration is valid.`

- [ ] **Step 5: Plan + apply**

Run:
```bash
terraform plan -out tfplan && terraform apply tfplan
```
Expected: 6 resources created (`aws_s3_bucket.state`, versioning, encryption, public_access_block, `aws_dynamodb_table.lock`). If the bucket name collides globally, set `-var state_bucket_name=awsops-v2-tfstate-<account-id>` and re-run; record the chosen name for Task 2.

- [ ] **Step 6: Verify**

Run:
```bash
aws s3api head-bucket --bucket "$(terraform output -raw state_bucket)" && echo "BUCKET_OK"
aws dynamodb describe-table --table-name "$(terraform output -raw lock_table)" --query 'Table.TableStatus' --output text
```
Expected: `BUCKET_OK` then `ACTIVE`.

- [ ] **Step 7: Commit**

```bash
git add terraform/v2/bootstrap
git commit -m "feat(v2-p1a): terraform remote-state backend (S3 + DynamoDB)"
```

---

## Task 2: Foundation skeleton — backend + providers + variables

**Files:**
- Create: `terraform/v2/foundation/backend.tf`
- Create: `terraform/v2/foundation/providers.tf`
- Create: `terraform/v2/foundation/variables.tf`
- Create: `terraform/v2/foundation/terraform.tfvars.example`

- [ ] **Step 1: Write `backend.tf`** (use the bucket/table names from Task 1; replace `awsops-v2-tfstate` if you overrode it)

```hcl
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
  backend "s3" {
    bucket         = "awsops-v2-tfstate"
    key            = "foundation/terraform.tfstate"
    region         = "ap-northeast-2"
    dynamodb_table = "awsops-v2-tflock"
    encrypt        = true
  }
}
```

- [ ] **Step 2: Write `providers.tf`** (the `use1` alias is mandatory — CloudFront certs must be in us-east-1)

```hcl
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Module    = "foundation"
    }
  }
}

provider "aws" {
  alias  = "use1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Module    = "foundation"
    }
  }
}
```

- [ ] **Step 3: Write `variables.tf`**

```hcl
variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "project" {
  type    = string
  default = "awsops-v2"
}

variable "domain_name" {
  type        = string
  description = "Public FQDN served by CloudFront, e.g. v2.atomai.click"
}

variable "hosted_zone_name" {
  type        = string
  description = "Route53 public hosted zone, e.g. atomai.click"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "azs" {
  type        = list(string)
  description = "Two AZs for subnets"
  default     = ["ap-northeast-2a", "ap-northeast-2c"]
}

variable "image_tag" {
  type        = string
  description = "Spine image tag in ECR"
  default     = "spine-latest"
}
```

- [ ] **Step 4: Write `terraform.tfvars.example`**

```hcl
domain_name      = "v2.atomai.click"
hosted_zone_name = "atomai.click"
# vpc_cidr       = "10.20.0.0/16"   # uncomment to override
```

- [ ] **Step 5: Init against the remote backend**

Run:
```bash
cd terraform/v2/foundation
cp terraform.tfvars.example terraform.tfvars
terraform init
```
Expected: `Successfully configured the backend "s3"! ... Terraform has been successfully initialized!`

- [ ] **Step 6: Validate**

Run: `terraform fmt && terraform validate`
Expected: `Success! The configuration is valid.` (No resources yet — only providers/vars.)

- [ ] **Step 7: Commit** (`.gitignore` must exclude real tfvars)

```bash
printf '%s\n' 'terraform/v2/**/.terraform/*' 'terraform/v2/**/terraform.tfvars' 'terraform/v2/**/*.tfplan' >> .gitignore
git add terraform/v2/foundation/backend.tf terraform/v2/foundation/providers.tf terraform/v2/foundation/variables.tf terraform/v2/foundation/terraform.tfvars.example .gitignore
git commit -m "feat(v2-p1a): foundation skeleton (s3 backend, dual-region providers, vars)"
```

---

## Task 3: Network — VPC, subnets, NAT, routes

**Files:**
- Create: `terraform/v2/foundation/network.tf`

- [ ] **Step 1: Write `network.tf`**

```hcl
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-vpc" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-igw" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)       # 10.20.0.0/24, 10.20.1.0/24
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)        # 10.20.10.0/24, 10.20.11.0/24
  availability_zone = var.azs[count.index]
  tags              = { Name = "${var.project}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.project}-nat-eip" }
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.project}-nat" }
  depends_on    = [aws_internet_gateway.igw]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = { Name = "${var.project}-public-rt" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat.id
  }
  tags = { Name = "${var.project}-private-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
```

- [ ] **Step 2: Validate**

Run: `terraform fmt && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan + apply**

Run: `terraform plan -out tfplan && terraform apply tfplan`
Expected: ~13 resources created (VPC, IGW, 2 public + 2 private subnets, EIP, NAT, 2 route tables, 4 associations).

- [ ] **Step 4: Verify**

Run:
```bash
aws ec2 describe-vpcs --filters "Name=tag:Name,Values=awsops-v2-vpc" \
  --query 'Vpcs[0].CidrBlock' --output text
```
Expected: `10.20.0.0/16`.

- [ ] **Step 5: Commit**

```bash
git add terraform/v2/foundation/network.tf
git commit -m "feat(v2-p1a): VPC, 2x public/private subnets, NAT, routes"
```

---

## Task 4: Spine container (Node SSE/health server) + ECR repo

**Files:**
- Create: `spine/server.js`
- Create: `spine/Dockerfile`
- Create: `terraform/v2/foundation/workload.tf` (ECR repo only in this task)

- [ ] **Step 1: Write `spine/server.js`**

```js
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/awsops/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/awsops/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write(`data: tick ${n}\n\n`);
      if (n >= 10) {
        clearInterval(timer);
        res.end('data: done\n\n');
      }
    }, 1000);
    req.on('close', () => clearInterval(timer));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`spine listening on ${PORT}`));
```

- [ ] **Step 2: Write `spine/Dockerfile`**

```dockerfile
FROM public.ecr.aws/docker/library/node:20-alpine
WORKDIR /app
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 3: Smoke-test the spine locally (fails first if server.js is wrong)**

Run:
```bash
node spine/server.js &
sleep 1
curl -s localhost:3000/awsops/healthz; echo
curl -sN localhost:3000/awsops/api/stream | head -3
kill %1
```
Expected: `ok`, then `data: tick 1`, `data: tick 2`, `data: tick 3` (one per second).

- [ ] **Step 4: Add the ECR repo to `workload.tf`**

```hcl
resource "aws_ecr_repository" "spine" {
  name                 = "${var.project}-spine"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true   # spine is throwaway; replaced by real image in P1d
}
```

- [ ] **Step 5: Apply just the ECR repo**

Run: `terraform apply -target=aws_ecr_repository.spine`
Expected: 1 resource created. Capture the URI:
```bash
ECR_URI=$(aws ecr describe-repositories --repository-names awsops-v2-spine \
  --query 'repositories[0].repositoryUri' --output text); echo "$ECR_URI"
```

- [ ] **Step 6: Build (arm64) + push**

Run:
```bash
aws ecr get-login-password --region ap-northeast-2 \
  | docker login --username AWS --password-stdin "${ECR_URI%/*}"
docker buildx build --platform linux/arm64 -t "$ECR_URI:spine-latest" spine --push
```
Expected: `pushing manifest ... done`.

- [ ] **Step 7: Verify the image exists**

Run:
```bash
aws ecr describe-images --repository-name awsops-v2-spine \
  --query 'imageDetails[?contains(imageTags,`spine-latest`)].imageTags' --output text
```
Expected: `spine-latest`.

- [ ] **Step 8: Commit**

```bash
git add spine terraform/v2/foundation/workload.tf
git commit -m "feat(v2-p1a): spine Node SSE/health container + ECR repo"
```

---

## Task 5: Workload — ECS cluster, task def, internal ALB, service

**Files:**
- Modify: `terraform/v2/foundation/workload.tf` (append to the ECR repo from Task 4)

- [ ] **Step 1: Append ECS cluster + IAM + log group + task definition**

```hcl
resource "aws_ecs_cluster" "main" {
  name = "${var.project}"
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
      name      = "spine"
      image     = "${aws_ecr_repository.spine.repository_url}:${var.image_tag}"
      essential = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment = [{ name = "PORT", value = "3000" }]
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
```

- [ ] **Step 2: Append SGs — internal ALB (from VPC CIDR) + service (from ALB)**

```hcl
# Internal ALB SG. The ALB is NOT internet-facing; CloudFront reaches it
# through a VPC Origin whose managed ENIs live in our private subnets, so
# allowing the VPC CIDR inbound is a correct (and private) source. Tightened
# to a dedicated VPC-origin SG as a follow-up once the GA SG mechanism is
# confirmed in Step 7 verification.
resource "aws_security_group" "alb" {
  name        = "${var.project}-alb-sg"
  description = "Internal ALB - reachable from within the VPC (CloudFront VPC Origin ENIs)"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from within VPC (incl. CloudFront VPC Origin ENIs)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
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
  vpc_id      = aws_vpc.main.id

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
```

- [ ] **Step 3: Append internal ALB + target group + listener**

```hcl
resource "aws_lb" "internal" {
  name               = "${var.project}-alb"
  internal           = true                       # KEY: private LB, not internet-facing
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.private[*].id
}

resource "aws_lb_target_group" "spine" {
  name        = "${var.project}-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"                              # required for Fargate awsvpc

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

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.spine.arn
  }
}
```

- [ ] **Step 4: Append the ECS service**

```hcl
resource "aws_ecs_service" "spine" {
  name            = "${var.project}-spine"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.spine.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
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

  depends_on = [aws_lb_listener.http]
}
```

- [ ] **Step 5: Validate**

Run: `terraform fmt && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 6: Plan + apply**

Run: `terraform plan -out tfplan && terraform apply tfplan`
Expected: cluster, 2 IAM roles + attachment, log group, task def, 2 SGs, ALB, target group, listener, service created.

- [ ] **Step 7: Verify the task is healthy behind the internal ALB**

Run (wait ~90s for the task to reach RUNNING + target HEALTHY):
```bash
aws ecs wait services-stable --cluster awsops-v2 --services awsops-v2-spine
TG_ARN=$(aws elbv2 describe-target-groups --names awsops-v2-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text
```
Expected: `healthy`. (The ALB is internal so it cannot be curled from your laptop yet — that happens through CloudFront in Task 6.)

- [ ] **Step 8: Commit**

```bash
git add terraform/v2/foundation/workload.tf
git commit -m "feat(v2-p1a): ECS Fargate spine service behind internal ALB"
```

---

## Task 6: Edge — ACM cert, CloudFront VPC Origin, distribution, DNS

**Files:**
- Create: `terraform/v2/foundation/edge.tf`
- Create: `terraform/v2/foundation/outputs.tf`

- [ ] **Step 1: Write the ACM cert (us-east-1) + DNS validation in `edge.tf`**

```hcl
data "aws_route53_zone" "main" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "cf" {
  provider          = aws.use1
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cf_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cf.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "cf" {
  provider                = aws.use1
  certificate_arn         = aws_acm_certificate.cf.arn
  validation_record_fqdns = [for r in aws_route53_record.cf_validation : r.fqdn]
}
```

- [ ] **Step 2: Append the CloudFront VPC Origin + managed policy data sources**

```hcl
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# CloudFront VPC Origin — lets CloudFront reach the INTERNAL ALB without it
# being internet-facing. Requires aws provider >= 5.73.
resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name                   = "${var.project}-alb-origin"
    arn                    = aws_lb.internal.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}
```

- [ ] **Step 3: Append the CloudFront distribution + Route53 alias**

```hcl
resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  comment         = "AWSops v2 spine — ${var.domain_name}"
  aliases         = [var.domain_name]
  price_class     = "PriceClass_200"

  origin {
    domain_name = aws_lb.internal.dns_name
    origin_id   = "alb-vpc-origin"
    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.alb.id
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb-vpc-origin"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  ordered_cache_behavior {
    path_pattern             = "/awsops/_next/static/*"
    target_origin_id         = "alb-vpc-origin"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.optimized.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "alias" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
```

- [ ] **Step 4: Write `outputs.tf`**

```hcl
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
  value = aws_ecr_repository.spine.repository_url
}
```

- [ ] **Step 5: Validate**

Run: `terraform fmt && terraform validate`
Expected: `Success! The configuration is valid.`

> If `terraform validate` rejects `aws_cloudfront_vpc_origin` or the `vpc_origin_config` block, the provider is older than 5.73. Run `terraform init -upgrade` and confirm `terraform version` shows aws provider `>= 5.73`. This is the single most likely schema-version failure in this plan.

- [ ] **Step 6: Plan + apply**

Run: `terraform plan -out tfplan && terraform apply tfplan`
Expected: ACM cert + validation records + validation, VPC origin, distribution, Route53 alias created. The distribution + ACM validation can take 5–10 minutes.

- [ ] **Step 7: Verify health through the full edge**

Run (CloudFront + DNS propagation can take a few minutes after apply):
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://v2.atomai.click/awsops/healthz
```
Expected: `200`. If `502`/`503`, the VPC origin → internal ALB path is failing — see Task 7.

- [ ] **Step 8: Commit**

```bash
git add terraform/v2/foundation/edge.tf terraform/v2/foundation/outputs.tf
git commit -m "feat(v2-p1a): private edge — CloudFront VPC Origin to internal ALB + ACM + DNS"
```

---

## Task 7: Verify SSE end-to-end through CloudFront (the P1a acceptance gate)

**Files:** none (verification + documentation task)

- [ ] **Step 1: Confirm health endpoint**

Run:
```bash
curl -s https://v2.atomai.click/awsops/healthz; echo
```
Expected: `ok`.

- [ ] **Step 2: Confirm SSE streams incrementally (not buffered)**

Run:
```bash
curl -N -s https://v2.atomai.click/awsops/api/stream
```
Expected: ten lines arriving **one per second** (`data: tick 1` … `data: tick 10`), then `data: done`. If all ten arrive at once after ~10s, CloudFront/ALB is buffering — record this; it blocks ADR-021 SSE and must be resolved before P1d ships the real app.

- [ ] **Step 3: Measure time-to-first-byte and inter-event gap**

Run:
```bash
curl -N -s -w "\nTTFB=%{time_starttransfer}s TOTAL=%{time_total}s\n" https://v2.atomai.click/awsops/api/stream | tail -3
```
Expected: `TTFB` < 2s and `TOTAL` ≈ 10s (proves the connection stays open and streams for the full duration, i.e. no premature CloudFront origin read-timeout cut-off).

- [ ] **Step 4: If SSE buffers or times out — apply the documented mitigations and re-test**

Mitigations, in order (apply one, re-run Step 2, stop when streaming works):
1. **Origin keepalive:** the spine already sends an event every 1s; confirm CloudFront's default origin read timeout (30s) is not exceeded by the gap. Real app must send a heartbeat comment (`: keepalive\n\n`) at least every 20s — note this requirement for P1d.
2. **ALB idle timeout:** raise from the 60s default. Add to `aws_lb.internal`:
   ```hcl
   idle_timeout = 300
   ```
   Then `terraform apply` and re-test.
3. **Disable response buffering at the edge:** confirm the `Managed-CachingDisabled` policy is attached to the default behavior (it is, in Task 6 Step 3). Caching must be off for the SSE path.

- [ ] **Step 5: Confirm the ALB is genuinely private (negative test)**

Run:
```bash
ALB_DNS=$(aws elbv2 describe-load-balancers --names awsops-v2-alb --query 'LoadBalancers[0].DNSName' --output text)
echo "ALB scheme: $(aws elbv2 describe-load-balancers --names awsops-v2-alb --query 'LoadBalancers[0].Scheme' --output text)"
curl -s -m 5 -o /dev/null -w "%{http_code}\n" "http://$ALB_DNS/awsops/healthz" || echo "UNREACHABLE_AS_EXPECTED"
```
Expected: scheme `internal`, and the direct curl from your laptop prints `UNREACHABLE_AS_EXPECTED` (the internal ALB has no public IP). This proves the edge is private.

- [ ] **Step 6: Record results in the plan and commit a short verification note**

Create `terraform/v2/foundation/VERIFY.md`:
```markdown
# P1a verification (fill in actual values)
- Date:
- `https://v2.atomai.click/awsops/healthz` -> 200: [yes/no]
- SSE streamed incrementally (1/s): [yes/no]
- TTFB: __s, total: __s
- ALB scheme internal + laptop-unreachable: [yes/no]
- SSE mitigations applied (if any): [none / idle_timeout=300 / ...]
- P1d note: real app must heartbeat SSE every <=20s
```

```bash
git add terraform/v2/foundation/VERIFY.md
git commit -m "test(v2-p1a): verify private edge serves health + SSE end-to-end"
```

---

## Task 8: Teardown rehearsal (prove the spine is reproducible/disposable)

**Files:** none

- [ ] **Step 1: Confirm a clean re-apply is a no-op (idempotency)**

Run: `terraform plan`
Expected: `No changes. Your infrastructure matches the configuration.`

- [ ] **Step 2: (Optional, only if validating teardown) Destroy + re-apply**

> Skip if the spine should stay up for P1b. If run, this proves disposability.
```bash
terraform destroy            # type 'yes'
terraform apply              # rebuild from scratch
```
Expected: destroy removes all foundation resources except the remote-state backend (separate module); re-apply recreates them and `curl https://v2.atomai.click/awsops/healthz` returns `ok` again after CloudFront re-propagates.

- [ ] **Step 3: Final commit (plan doc completion marker)**

```bash
git commit --allow-empty -m "chore(v2-p1a): foundation spine complete — edge verified, ready for P1b auth"
```

---

## Self-Review

**Spec coverage (P1a slice of the design spec §2.1, §8, §9-P1):**
- Internal ALB + CloudFront VPC Origin (spec §2.1) → Tasks 5–6. ✓
- ALB SG = VPC-sourced, not prefix-list (spec §2.1 "완전 사설") → Task 5 Step 2 (with documented tightening follow-up). ✓
- SSE-over-VPC-Origin verification (spec §2.1, §9-P1 완료기준, §11 위험) → Task 7. ✓
- Terraform remote state + multi-module layout (spec §8) → Tasks 1–2. ✓
- New domain, parallel to v1 (spec §1, §8 완전 분리 병렬) → `v2.atomai.click`, separate VPC `10.20.0.0/16`. ✓
- Steampipe-as-sidecar / web container details → **deferred to P1d** (real image); P1a uses a spine stand-in. Documented in Goal/out-of-scope. ✓
- Aurora, Cognito, CI/CD, make configure, EKS module, AgentCore provisioner → **explicitly deferred** to P1b–P1f (scope check). ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases." The one schema-version caveat (Task 6 Step 5) and SSE mitigations (Task 7 Step 4) are concrete, conditional, with exact commands — not placeholders.

**Type/name consistency:** Resource names referenced across files are consistent: `aws_lb.internal`, `aws_ecr_repository.spine`, `aws_security_group.alb`/`.service`, `aws_lb_target_group.spine`, `aws_cloudfront_vpc_origin.alb`, cluster/service `awsops-v2`/`awsops-v2-spine`, health path `/awsops/healthz`, SSE path `/awsops/api/stream`, image tag `spine-latest` (= `var.image_tag` default). Health-check matcher `200-399` matches the dev-stack precedent.

---

## Execution Handoff

(filled in by the writing-plans flow after save)
