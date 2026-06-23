# AWSops 인프라 CDK / AWSops Infrastructure CDK

AWSops 대시보드 CloudFormation 인프라를 CDK로 재구성한 프로젝트입니다.
(CDK project that recreates the AWSops Dashboard CloudFormation infrastructure.)

## 스택 / Stacks

| Stack | Description |
|-------|-------------|
| `AwsopsStack` | VPC, ALB, EC2, CloudFront, SSM endpoints |
| `AwsopsCognitoStack` | Cognito User Pool, Lambda@Edge auth (us-east-1) |
| `AwsopsAgentCoreStack` | AgentCore placeholder (deploy via script) |

## 사전 요구 사항 / Prerequisites

- Node.js 20+
- AWS CDK CLI: `npm install -g aws-cdk`
- AWS 자격 증명 설정 완료 (AWS credentials configured)
- 해당 리전의 CloudFront 접두사 목록 ID (CloudFront prefix list ID for your region)

## 빠른 시작 / Quick Start

```bash
cd infra-cdk
npm install

# Bootstrap CDK (first time only)
cdk bootstrap aws://ACCOUNT_ID/ap-northeast-2
cdk bootstrap aws://ACCOUNT_ID/us-east-1  # for Lambda@Edge

# Review changes
cdk diff

# Deploy all stacks
cdk deploy --all \
  --parameters AwsopsStack:VSCodePassword=YOUR_PASSWORD \
  --parameters AwsopsStack:CloudFrontPrefixListId=pl-22a6434b \
  --parameters AwsopsStack:InstanceType=t4g.2xlarge
```

## 파라미터 / Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `InstanceType` | `t4g.2xlarge` | EC2 instance type (ARM64 Graviton) |
| `VSCodePassword` | (required) | code-server password (min 8 chars) |
| `CloudFrontPrefixListId` | (required) | CloudFront prefix list for ALB SG |

## 아키텍처 / Architecture

```
Internet -> CloudFront (HTTPS)
              |-- /awsops*       -> ALB:3000 -> EC2:3000 (Dashboard)
              |-- /awsops/_next  -> ALB:3000 (static, cached)
              |-- /*             -> ALB:80   -> EC2:8888 (VSCode)

VPC 10.254.0.0/16
  Public Subnets:  ALB, NAT Gateway
  Private Subnets: EC2, SSM VPC Endpoints
```

## 배포 후 단계 / Post-Deploy Steps

CDK 배포 후, 아래 설정 스크립트를 순서대로 실행하세요:
(After CDK deploy, continue with the setup scripts:)
1. SSM으로 EC2 접속: `aws ssm start-session --target INSTANCE_ID` (SSM into EC2)
2. `01-install-base.sh` 실행 — 기본 도구 설치 (Steampipe + Powerpipe)
3. `02-setup-nextjs.sh` 실행 — Next.js 앱 설정 (Next.js app)
4. `03-build-deploy.sh` 실행 — 빌드 및 실행 (build and start)
5. `05-setup-cognito.sh` 실행 — Cognito 콜백 URL 업데이트 (update Cognito callback URLs)
6. `06-setup-agentcore.sh` 실행 — AI 에이전트 설정 (AI agent)

## 정리 / Cleanup

```bash
cdk destroy --all
```
