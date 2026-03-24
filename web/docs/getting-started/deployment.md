---
sidebar_position: 4
title: 배포 가이드
description: AWSops 배포 단계 및 요구사항
---

import DeploymentPipeline from '@site/src/components/diagrams/DeploymentPipeline';

# 배포 가이드

AWSops를 새 AWS 계정에 배포하기 위한 전체 과정을 설명합니다.

<DeploymentPipeline />

## Prerequisites

| 항목 | 요구사항 |
|------|----------|
| **AWS 계정** | 적절한 IAM 권한 (Admin 또는 PowerUser) |
| **CDK CLI** | 로컬 머신에 설치 (`npm install -g aws-cdk`) |
| **Docker** | arm64 빌드 지원 (`docker buildx`) |
| **Node.js** | v20 이상 |
| **AWS CLI** | v2, 프로필 설정 완료 |

## 배포 단계

### Step 0: CDK 인프라 배포 (로컬)

```bash
cd infra-cdk && cdk deploy --all
```

CDK가 배포하는 리소스:
- **VPC**: 10.254.0.0/16, 2 AZ, NAT Gateway, Public + Private Subnet
- **EC2**: t4g.2xlarge (ARM64 Graviton), 100GB GP3, Private Subnet
- **ALB**: Internet-facing, Custom Header 검증
- **CloudFront**: CACHING_DISABLED, ALB Origin
- **Cognito**: User Pool + Lambda@Edge (us-east-1)

### Step 1: Steampipe 설치 (EC2)

```bash
bash scripts/01-install-base.sh
```

Steampipe + AWS/K8s/Trivy 플러그인 설치. PostgreSQL port 9193에서 380+ AWS 테이블 사용 가능.

### Step 2: Next.js 설정 (EC2)

```bash
bash scripts/02-setup-nextjs.sh
```

Next.js 14 앱 설치, Steampipe 서비스 등록, MSP 환경 자동 감지.

### Step 3: 프로덕션 빌드 (EC2)

```bash
bash scripts/03-build-deploy.sh
```

`npm run build` + `npm start`로 프로덕션 서버 실행.

### Step 5: Cognito 인증 (EC2)

```bash
bash scripts/05-setup-cognito.sh
```

Cognito User Pool 사용자 생성 및 앱 클라이언트 설정.

### Step 6a-6f: AgentCore (EC2)

| 스크립트 | 설명 |
|----------|------|
| `06a-setup-agentcore-runtime.sh` | IAM 역할, ECR, Docker arm64 빌드, Runtime Endpoint |
| `06b-setup-agentcore-gateway.sh` | 8개 Gateway 생성 (MCP) |
| `06c-setup-agentcore-tools.sh` | 19 Lambda + 8 Gateway에 125 도구 등록 |
| `06d-setup-agentcore-interpreter.sh` | Code Interpreter 생성 |
| `06e-setup-agentcore-memory.sh` | Memory Store 생성 (365일 보관) |
| `06f-setup-opencost.sh` | Prometheus + OpenCost (EKS 비용 분석) |

### Step 7: CloudFront 인증 연동 (EC2)

```bash
bash scripts/07-setup-cloudfront-auth.sh
```

Lambda@Edge를 CloudFront viewer-request에 연결.

## 설정 파일

배포 완료 후 `data/config.json`이 자동 생성됩니다. 새 계정에 배포할 때는 이 파일만 업데이트하면 됩니다.

```json
{
  "costEnabled": true,
  "agentRuntimeArn": "arn:aws:bedrock-agentcore:REGION:ACCOUNT:runtime/RUNTIME_ID",
  "codeInterpreterName": "awsops_code_interpreter-XXXXX",
  "memoryId": "awsops_memory-XXXXX",
  "memoryName": "awsops_memory"
}
```

:::tip 코드 수정 불필요
계정별 배포 시 `data/config.json`만 변경하면 됩니다. 소스 코드 수정은 필요하지 않습니다.
:::

## 관련 페이지

- [인증 흐름](./auth) - Cognito 인증 상세
- [AgentCore](../overview/agentcore) - AgentCore 아키텍처 상세
- [대시보드](../overview/dashboard) - 시스템 아키텍처 개요
