# AWSops Dashboard

[![GitHub stars](https://img.shields.io/github/stars/Atom-oh/awsops?style=flat&logo=github)](https://github.com/Atom-oh/awsops/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/Atom-oh/awsops?style=flat&logo=github)](https://github.com/Atom-oh/awsops/network/members)
[![GitHub issues](https://img.shields.io/github/issues/Atom-oh/awsops)](https://github.com/Atom-oh/awsops/issues)
[![License](https://img.shields.io/github/license/Atom-oh/awsops)](LICENSE)
[![Version](https://img.shields.io/badge/version-v1.9.4-green.svg)](https://github.com/Atom-oh/awsops/releases)
[![Last commit](https://img.shields.io/github/last-commit/Atom-oh/awsops)](https://github.com/Atom-oh/awsops/commits/main)
[![PR Review](https://github.com/Atom-oh/awsops/actions/workflows/pr-review.yml/badge.svg)](https://github.com/Atom-oh/awsops/actions/workflows/pr-review.yml)

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

AWS + Kubernetes operations dashboard with real-time monitoring, network troubleshooting, CIS compliance, and AI-powered analysis — built on Steampipe, Next.js 14, and Amazon Bedrock AgentCore. | Steampipe, Next.js 14, Amazon Bedrock AgentCore 기반 실시간 모니터링·네트워크 트러블슈팅·CIS 컴플라이언스·AI 분석 AWS + Kubernetes 운영 대시보드입니다.

---

<a id="english"></a>

# English

## Overview

AWSops is a single-pane operations dashboard for AWS and Kubernetes. It combines real-time resource monitoring, network troubleshooting, CIS compliance scanning, external observability integration, and AI-powered diagnosis — all backed by Steampipe (embedded PostgreSQL over 380+ AWS tables and 60+ Kubernetes tables) and Amazon Bedrock AgentCore.

![AWSops Architecture](images/awsops_arch_01.png)

```
Internet -> CloudFront (Lambda@Edge Cognito auth) -> ALB -> EC2 (t4g.2xlarge, private subnet)
  EC2: Next.js :3000  |  Steampipe :9193 (embedded PostgreSQL)  |  Powerpipe (CIS)  |  Docker (build only)
  -> Amazon Bedrock AgentCore: 1 Runtime (Strands) + 8 Gateways (125 MCP tools) + 19 Lambda + Code Interpreter
```

Stats: 43 pages, 55 routes, 26 SQL query files, 20 API routes, 18 components, 125 MCP tools (8 Gateways, 19 Lambda), 31 ADRs.

> A **v2 rewrite** — Terraform MSA on ECS Fargate + Aurora Serverless v2 + AgentCore, a private CloudFront-VPC-Origin edge, an async worker tier, and a runtime-customizable Agent Space — is substantially built on the `feat/v2-architecture-design` branch (this v1 app remains the legacy production release). v2's posture is a **read-only ops dashboard + AI diagnosis**: a mutating/autonomous tier was prototyped behind disabled flags and then **reversed** (2026-06-11) — infra mutation stays with the operator's own SSM/Change Manager/IaC.

## Features

- **Resource monitoring (43 pages)** -- EC2, Lambda, ECS/ECR, EKS (pods, nodes, deployments, services, explorer), VPC and network, CloudFront, WAF, EBS, S3, RDS, DynamoDB, ElastiCache, MSK, OpenSearch — with live charts and a React Flow topology map.
- **AI assistant (multi-route)** -- A classifier routes each question to 1-3 of 8 AgentCore gateways in parallel and synthesizes the result, with SSE streaming, a Python Code Interpreter, and conversation history.
- **Multi-account** -- Steampipe aggregator pattern: switch accounts or view all merged, configured via `data/config.json` with no code changes.
- **CIS compliance** -- Powerpipe benchmarks (CIS v1.5–v4.0, 400+ controls).
- **Cost and FinOps** -- Cost Explorer, container cost (ECS Fargate pricing and EKS OpenCost), and resource inventory trends.
- **External datasources** -- Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, and Datadog (SSRF-protected with an allowlist).
- **AI diagnosis and alerting** -- 15-section Bedrock report (DOCX/MD/PDF export), alert-triggered auto-diagnosis, Slack notifications, and event pre-scaling plans.

### AI Gateways (125 MCP tools)

| Gateway | Tools | Capabilities |
|---------|-------|--------------|
| Network | 17 | VPC, TGW, VPN, ENI, Reachability Analyzer, Flow Logs |
| Container | 24 | EKS cluster/node/pod, ECS service/task, Istio mesh |
| IaC | 12 | CloudFormation validate, CDK docs, Terraform modules |
| Data | 24 | DynamoDB, RDS Data API, ElastiCache, MSK |
| Security | 14 | IAM users/roles/policies, policy simulation |
| Monitoring | 16 | CloudWatch metrics/alarms, Log Insights, CloudTrail |
| Cost | 9 | Cost Explorer, Pricing, Budgets, forecasts |
| Ops | 9 | AWS docs, CLI execution, Steampipe SQL |

Models: Claude Sonnet 4.6 (default), Opus 4.8 (deep analysis), Haiku 4.5 (fast/low-cost).

## Prerequisites

- AWS account with administrator access
- EC2 instance (Amazon Linux 2023, t4g.2xlarge or larger, ARM64)
- AWS credentials configured
- Node.js 20 or later
- kubectl and a kubeconfig (for Kubernetes features)

## Installation

```bash
# Clone the repository
git clone https://github.com/Atom-oh/awsops.git
cd awsops

# Step 0: Deploy CDK infrastructure (run from your local machine)
export VSCODE_PASSWORD='YourPassword'
bash scripts/00-deploy-infra.sh        # VPC, EC2, ALB, CloudFront, SSM endpoints

# Connect to the EC2 instance
aws ssm start-session --target <instance-id>

# Steps 1-3: Install the dashboard (on EC2)
cd /home/ec2-user/awsops
bash scripts/install-all.sh            # 01 install-base -> 02 setup-nextjs -> 03 build-deploy

# Step 5: Cognito authentication
bash scripts/05-setup-cognito.sh

# Steps 6a-6f: AgentCore AI (Runtime, 8 Gateways, 19 Lambda, Code Interpreter, Memory)
bash scripts/06a-setup-agentcore-runtime.sh
bash scripts/06b-setup-agentcore-gateway.sh
bash scripts/06c-setup-agentcore-tools.sh
bash scripts/06d-setup-agentcore-interpreter.sh
bash scripts/06e-setup-agentcore-config.sh
bash scripts/06f-setup-agentcore-memory.sh

# Step 8: Attach Lambda@Edge to CloudFront
bash scripts/08-setup-cloudfront-auth.sh
```

## Usage

```bash
bash scripts/09-start-all.sh           # Start all services + print URLs
bash scripts/10-stop-all.sh            # Stop all services
bash scripts/11-verify.sh              # Health check (ports, queries, gateway responses)
bash scripts/12-setup-multi-account.sh # Optional: multi-account aggregator + cross-account role
```

## Configuration

Copy `.env.example` to `.env.local` and adjust as needed:

| Variable | Description | Default |
|----------|-------------|---------|
| `STEAMPIPE_PASSWORD` | Steampipe embedded PostgreSQL password | `steampipe` |
| `AWS_REGION` | Default AWS region | `ap-northeast-2` |
| `NODE_ENV` | Node.js environment | `production` |
| `PORT` | Next.js server port | `3000` |
| `NEXT_PUBLIC_BASE_PATH` | Next.js base path | `/awsops` |

Application runtime configuration — AgentCore ARNs, multi-account list, and feature flags — lives in `data/config.json`.

## Project Structure

```
awsops/
  src/app/         # 43 pages + 20 API routes (Next.js App Router)
  src/components/   # 18 shared components (charts, tables, K8s, layout)
  src/lib/          # steampipe pg Pool, 26 query files, collectors, datasource clients
  src/contexts/     # multi-account state
  agent/            # Strands Agent source + 19 Lambda (built on EC2 -> ECR -> AgentCore)
  powerpipe/        # CIS Benchmark mod
  infra-cdk/        # CDK (VPC/EC2/ALB/CloudFront, Cognito/Lambda@Edge)
  terraform/v2/     # v2 rewrite (in progress)
  scripts/          # 17 install and operations scripts (00-12)
  docs/             # guides, runbooks, 31 ADRs
```

## Testing

```bash
npm test               # vitest run
npm run test:watch     # watch mode
npm run test:coverage  # coverage report
```

## API Documentation

The 20 API routes live under `src/app/api/`. Key routes: `ai` (11-route AI classifier), `steampipe` (queries, cost availability, inventory), `report` (AI diagnosis), `alert-webhook`, `notification`, `event-scaling`, plus per-service CloudWatch metric routes (`msk`, `rds`, `elasticache`, `opensearch`). See [docs/architecture.md](docs/architecture.md) for details.

## Contributing

1. Fork the repository
2. Create your branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

## License

Licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Contact

- Maintainer: [Atom-oh](https://github.com/Atom-oh)
- Issues: [github.com/Atom-oh/awsops/issues](https://github.com/Atom-oh/awsops/issues)

---

<a id="korean"></a>

# 한국어

## 개요

AWSops는 AWS와 Kubernetes를 위한 단일 화면 운영 대시보드입니다. 실시간 리소스 모니터링, 네트워크 트러블슈팅, CIS 컴플라이언스 스캔, 외부 옵저버빌리티 연동, AI 기반 진단을 하나로 제공하며, Steampipe(380+ AWS 테이블과 60+ Kubernetes 테이블에 대한 내장 PostgreSQL)와 Amazon Bedrock AgentCore를 기반으로 동작합니다.

![AWSops Architecture](images/awsops_arch_01.png)

```
Internet -> CloudFront (Lambda@Edge Cognito 인증) -> ALB -> EC2 (t4g.2xlarge, private subnet)
  EC2: Next.js :3000  |  Steampipe :9193 (내장 PostgreSQL)  |  Powerpipe (CIS)  |  Docker (빌드 전용)
  -> Amazon Bedrock AgentCore: 1 Runtime (Strands) + 8 Gateways (125 MCP 도구) + 19 Lambda + Code Interpreter
```

현황: 43 페이지, 55 라우트, 26 SQL 쿼리 파일, 20 API 라우트, 18 컴포넌트, 125 MCP 도구(8 Gateway, 19 Lambda), 31 ADR.

> **v2 재설계** — Terraform MSA(ECS Fargate + Aurora Serverless v2 + AgentCore) · 비공개 CloudFront VPC Origin 엣지 · 비동기 워커 계층 · 런타임 커스터마이즈 Agent Space — 가 `feat/v2-architecture-design` 브랜치에 상당 부분 구축됨(이 v1 앱은 레거시 프로덕션으로 유지). v2 자세는 **read-only 운영 대시보드 + AI 진단**: 변경/자율 계층은 비활성 플래그로 프로토타입 후 **번복**(2026-06-11) — 인프라 변경은 운영자의 SSM/Change Manager/IaC가 담당.

## 주요 기능

- **리소스 모니터링 (43 페이지)** -- EC2, Lambda, ECS/ECR, EKS(pod·node·deployment·service·explorer), VPC 및 네트워크, CloudFront, WAF, EBS, S3, RDS, DynamoDB, ElastiCache, MSK, OpenSearch를 실시간 차트와 React Flow 토폴로지 맵으로 제공합니다.
- **AI 어시스턴트 (멀티 라우트)** -- 분류기가 각 질문을 8개 AgentCore 게이트웨이 중 1~3개로 병렬 라우팅한 뒤 결과를 통합하며, SSE 스트리밍·Python Code Interpreter·대화 히스토리를 지원합니다.
- **멀티 어카운트** -- Steampipe aggregator 패턴으로 계정 전환 또는 전체 통합 조회가 가능하며, `data/config.json`만으로 코드 수정 없이 설정합니다.
- **CIS 컴플라이언스** -- Powerpipe 벤치마크(CIS v1.5~v4.0, 400+ 컨트롤).
- **비용 및 FinOps** -- Cost Explorer, 컨테이너 비용(ECS Fargate 가격 및 EKS OpenCost), 리소스 인벤토리 추이.
- **외부 데이터소스** -- Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog(SSRF 방지 + allowlist).
- **AI 진단 및 알림** -- 15섹션 Bedrock 리포트(DOCX/MD/PDF 내보내기), 알림 트리거 자동 진단, Slack 알림, 이벤트 사전 스케일링 플랜.

### AI 게이트웨이 (125 MCP 도구)

| Gateway | 도구 | 주요 기능 |
|---------|------|-----------|
| Network | 17 | VPC, TGW, VPN, ENI, Reachability Analyzer, Flow Logs |
| Container | 24 | EKS cluster/node/pod, ECS service/task, Istio mesh |
| IaC | 12 | CloudFormation 검증, CDK 문서, Terraform 모듈 |
| Data | 24 | DynamoDB, RDS Data API, ElastiCache, MSK |
| Security | 14 | IAM 사용자/역할/정책, 정책 시뮬레이션 |
| Monitoring | 16 | CloudWatch 메트릭/알람, Log Insights, CloudTrail |
| Cost | 9 | Cost Explorer, Pricing, Budgets, 예측 |
| Ops | 9 | AWS 문서, CLI 실행, Steampipe SQL |

모델: Claude Sonnet 4.6(기본), Opus 4.8(심층 분석), Haiku 4.5(빠르고 저렴).

## 사전 요구 사항

- 관리자 권한이 있는 AWS 계정
- EC2 인스턴스(Amazon Linux 2023, t4g.2xlarge 이상, ARM64)
- 구성된 AWS 자격 증명
- Node.js 20 이상
- kubectl 및 kubeconfig (Kubernetes 기능용)

## 설치 방법

```bash
# 저장소 복제
git clone https://github.com/Atom-oh/awsops.git
cd awsops

# Step 0: CDK 인프라 배포 (로컬 머신에서 실행)
export VSCODE_PASSWORD='YourPassword'
bash scripts/00-deploy-infra.sh        # VPC, EC2, ALB, CloudFront, SSM 엔드포인트

# SSM으로 EC2 인스턴스 접속
aws ssm start-session --target <instance-id>

# Step 1-3: 대시보드 설치 (EC2 내부)
cd /home/ec2-user/awsops
bash scripts/install-all.sh            # 01 install-base -> 02 setup-nextjs -> 03 build-deploy

# Step 5: Cognito 인증
bash scripts/05-setup-cognito.sh

# Step 6a-6f: AgentCore AI (Runtime, 8 Gateway, 19 Lambda, Code Interpreter, Memory)
bash scripts/06a-setup-agentcore-runtime.sh
bash scripts/06b-setup-agentcore-gateway.sh
bash scripts/06c-setup-agentcore-tools.sh
bash scripts/06d-setup-agentcore-interpreter.sh
bash scripts/06e-setup-agentcore-config.sh
bash scripts/06f-setup-agentcore-memory.sh

# Step 8: Lambda@Edge를 CloudFront에 연결
bash scripts/08-setup-cloudfront-auth.sh
```

## 사용법

```bash
bash scripts/09-start-all.sh           # 전체 서비스 시작 + URL 출력
bash scripts/10-stop-all.sh            # 전체 서비스 중지
bash scripts/11-verify.sh              # 헬스체크 (포트, 쿼리, 게이트웨이 응답)
bash scripts/12-setup-multi-account.sh # 선택: 멀티 어카운트 aggregator + 교차 계정 역할
```

## 환경 설정

`.env.example`을 `.env.local`로 복사한 뒤 값을 조정합니다:

| Variable | 설명 | 기본값 |
|----------|------|--------|
| `STEAMPIPE_PASSWORD` | Steampipe 내장 PostgreSQL 비밀번호 | `steampipe` |
| `AWS_REGION` | 기본 AWS 리전 | `ap-northeast-2` |
| `NODE_ENV` | Node.js 환경 | `production` |
| `PORT` | Next.js 서버 포트 | `3000` |
| `NEXT_PUBLIC_BASE_PATH` | Next.js base path | `/awsops` |

애플리케이션 런타임 설정(AgentCore ARN, 멀티 어카운트 목록, feature flag)은 `data/config.json`에 있습니다.

## 프로젝트 구조

```
awsops/
  src/app/         # 43 페이지 + 20 API 라우트 (Next.js App Router)
  src/components/   # 18 공유 컴포넌트 (차트, 테이블, K8s, 레이아웃)
  src/lib/          # steampipe pg Pool, 26 쿼리 파일, 컬렉터, 데이터소스 클라이언트
  src/contexts/     # 멀티 어카운트 상태
  agent/            # Strands Agent 소스 + 19 Lambda (EC2에서 빌드 -> ECR -> AgentCore)
  powerpipe/        # CIS Benchmark mod
  infra-cdk/        # CDK (VPC/EC2/ALB/CloudFront, Cognito/Lambda@Edge)
  terraform/v2/     # v2 재설계 (진행 중)
  scripts/          # 17 설치 및 운영 스크립트 (00-12)
  docs/             # 가이드, 런북, 31 ADR
```

## 테스트

```bash
npm test               # vitest run
npm run test:watch     # watch 모드
npm run test:coverage  # 커버리지 리포트
```

## API 문서

20개 API 라우트가 `src/app/api/`에 있습니다. 주요 라우트: `ai`(11-route AI 분류기), `steampipe`(쿼리, 비용 가용성, 인벤토리), `report`(AI 진단), `alert-webhook`, `notification`, `event-scaling`, 그리고 서비스별 CloudWatch 메트릭 라우트(`msk`, `rds`, `elasticache`, `opensearch`). 자세한 내용은 [docs/architecture.md](docs/architecture.md)를 참고하세요.

## 기여 방법

1. 저장소를 Fork 합니다
2. 브랜치를 생성합니다 (`git checkout -b feat/amazing-feature`)
3. 변경 사항을 커밋합니다 (`git commit -m 'feat: add amazing feature'`)
4. 브랜치에 Push 합니다 (`git push origin feat/amazing-feature`)
5. Pull Request를 엽니다

## 라이선스

MIT License로 배포됩니다. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.

## 연락처

- 메인테이너: [Atom-oh](https://github.com/Atom-oh)
- 이슈: [github.com/Atom-oh/awsops/issues](https://github.com/Atom-oh/awsops/issues)
