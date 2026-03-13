# Project Structure / 프로젝트 구조

## Directory Map

```
awsops/
├── .kiro/                        # Kiro AI 설정
│   ├── AGENT.md                  # 에이전트 컨텍스트
│   ├── rules.md                  # 프로젝트 규칙
│   ├── steering/                 # 가이드라인
│   │   ├── coding-standards.md
│   │   ├── architecture-decisions.md
│   │   └── project-structure.md
│   └── docs/
│       ├── data-flow.md
│       └── troubleshooting-quick-ref.md
├── src/
│   ├── app/                      # 27 pages + 5 API routes
│   │   ├── page.tsx              # Dashboard (18 StatsCards)
│   │   ├── ai/                   # AI Assistant (SSE, multi-route)
│   │   ├── agentcore/            # AgentCore Dashboard
│   │   ├── ec2/ lambda/ ecs/ ecr/ # Compute
│   │   ├── k8s/                  # EKS (overview, pods, nodes, deployments, services, explorer)
│   │   ├── vpc/ cloudfront-cdn/ waf/ topology/ # Network & CDN
│   │   ├── s3/ rds/ dynamodb/ elasticache/     # Storage & DB
│   │   ├── monitoring/ cloudwatch/ cloudtrail/ cost/ # Monitoring
│   │   ├── iam/ security/ compliance/          # Security
│   │   └── api/                  # API routes
│   │       ├── ai/route.ts       # 10-route classifier + SSE
│   │       ├── steampipe/route.ts # Steampipe query endpoint
│   │       ├── agentcore/route.ts # AgentCore status
│   │       ├── code/route.ts     # Code Interpreter
│   │       └── benchmark/route.ts # CIS benchmark
│   ├── components/               # 14 shared components
│   │   ├── layout/               # Sidebar, Header
│   │   ├── dashboard/            # StatsCard, LiveResourceCard, StatusBadge
│   │   ├── charts/               # PieChartCard, BarChartCard, LineChartCard
│   │   ├── table/                # DataTable
│   │   └── k8s/                  # K9s-style (ResourceTable, DetailPanel, ClusterHeader)
│   ├── lib/
│   │   ├── steampipe.ts          # pg Pool (max 3, 120s timeout, 5min cache)
│   │   └── queries/              # 19 SQL files (ec2, vpc, s3, rds, k8s, iam, cost...)
│   └── types/aws.ts
├── agent/                        # Strands Agent (Docker arm64)
│   ├── agent.py                  # Dynamic gateway selection
│   ├── streamable_http_sigv4.py  # MCP + SigV4
│   ├── Dockerfile
│   └── lambda/                   # 19 Lambda sources + create_targets.py
├── infra-cdk/                    # CDK TypeScript
│   └── lib/
│       ├── awsops-stack.ts       # VPC, EC2, ALB, CloudFront
│       └── cognito-stack.ts      # Cognito, Lambda@Edge
├── powerpipe/                    # CIS Benchmark mod
├── scripts/                      # 17 install/ops scripts (00~10)
└── docs/                         # Guides, ADRs, Runbooks
```

## Page → Query → Data Mapping

| Page | Query File | Steampipe Tables |
|------|-----------|-----------------|
| Dashboard | ec2, vpc, s3, lambda, iam, security | Multiple (summary counts) |
| EC2 | ec2.ts | aws_ec2_instance |
| Lambda | lambda.ts | aws_lambda_function |
| VPC | vpc.ts | aws_vpc, aws_vpc_subnet, aws_vpc_security_group, aws_vpc_route_table, ... |
| S3 | s3.ts | aws_s3_bucket |
| RDS | rds.ts | aws_rds_db_instance |
| K8s | k8s.ts | kubernetes_node, kubernetes_pod, kubernetes_deployment, kubernetes_service |
| IAM | iam.ts | aws_iam_user, aws_iam_role |
| Cost | cost.ts | aws_cost_by_service_daily, aws_cost_by_service_monthly |
| Security | security.ts | aws_s3_bucket, aws_vpc_security_group, aws_ebs_volume, trivy_scan_vulnerability |
| Topology | relationships.ts | Multiple (cross-resource relationships) |
