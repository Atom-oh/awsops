# AWSops Dashboard - Installation Guide / AWSops 대시보드 - 설치 가이드

## Architecture Overview / 아키텍처 개요

```
Browser → CloudFront (Cognito Auth) → ALB → EC2 (Next.js:3000)
                                                │
                                                ├─ Steampipe (PostgreSQL:9193)
                                                │   ├─ AWS Plugin
                                                │   ├─ Kubernetes Plugin
                                                │   └─ Trivy Plugin (CVE)
                                                │
                                                ├─ Powerpipe (CIS Benchmark)
                                                │
                                                └─ Bedrock AI (us-east-1)
                                                    └─ AgentCore Runtime (Strands)
                                                        └─ AgentCore Gateway (MCP)
                                                            ├─ Lambda: Reachability Analyzer
                                                            ├─ Lambda: Flow Monitor
                                                            ├─ Lambda: Network MCP
                                                            └─ Lambda: Steampipe Query
```

## Dashboard Pages (21 pages) / 대시보드 페이지 (21개)

| Category | Page | Path | Features |
|----------|------|------|----------|
| **Overview** | Dashboard | `/awsops` | Stats, Live Resources, Charts, Warnings |
| | AI Assistant | `/awsops/ai` | Claude Sonnet/Opus 4.6, Steampipe context |
| **Compute** | EC2 | `/awsops/ec2` | Instances, detail panel |
| | Lambda | `/awsops/lambda` | Functions, runtimes |
| | ECS | `/awsops/ecs` | Clusters, services, tasks |
| | EKS | `/awsops/k8s` | Nodes, pods, deployments |
| | EKS Explorer | `/awsops/k8s/explorer` | K9s-style terminal UI |
| **Network** | VPC/Network | `/awsops/vpc` | VPC, Subnet, SG, TGW, ELB, NAT, IGW |
| | Topology | `/awsops/topology` | Interactive resource graph (React Flow) |
| **Storage & DB** | S3 | `/awsops/s3` | Buckets, versioning, public access |
| | RDS | `/awsops/rds` | Instances, engines |
| | DynamoDB | `/awsops/dynamodb` | Tables |
| | ElastiCache | `/awsops/elasticache` | Redis/Memcached clusters |
| **Monitoring** | Monitoring | `/awsops/monitoring` | CPU, Memory, Network, Disk I/O |
| | CloudWatch | `/awsops/cloudwatch` | Alarms |
| | CloudTrail | `/awsops/cloudtrail` | Trails, events |
| | Cost | `/awsops/cost` | Monthly/daily cost, service breakdown |
| **Security** | IAM | `/awsops/iam` | Users, roles, trust policies |
| | Security | `/awsops/security` | Public buckets, open SGs, CVE |
| | CIS Compliance | `/awsops/compliance` | CIS v1.5-v4.0 benchmarks |

## Prerequisites / 사전 요구 사항

- AWS Account with admin access (관리자 권한의 AWS 계정)
- EC2 Instance (Amazon Linux 2023, t3.medium+) (EC2 인스턴스)
- Node.js 20+
- Docker
- AWS CLI v2
- kubectl + kubeconfig (for K8s features) (K8s 기능에 필요)
- AWS credentials configured (AWS 자격 증명 설정 완료)

---

## Installation Steps / 설치 단계

### Quick Install (All-in-One) / 빠른 설치 (일괄 실행)

```bash
# Download and run (다운로드 후 실행)
curl -sL https://raw.githubusercontent.com/your-repo/awsops/main/scripts/install.sh | bash
```

### Or follow the step-by-step guide below. / 또는 아래의 단계별 가이드를 따르세요.
