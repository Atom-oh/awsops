# AWSops Infrastructure CDK / AWSops 인프라 CDK

CDK project that recreates the AWSops Dashboard CloudFormation infrastructure.
(AWSops 대시보드 CloudFormation 인프라를 CDK로 재구성한 프로젝트입니다.)

## Stacks / 스택

| Stack | Description |
|-------|-------------|
| `AwsopsStack` | VPC, ALB, EC2, CloudFront, SSM endpoints |
| `AwsopsCognitoStack` | Cognito User Pool, Lambda@Edge auth (us-east-1) |
| `AwsopsAgentCoreStack` | AgentCore placeholder (deploy via script) |

## Prerequisites / 사전 요구 사항

- Node.js 20+
- AWS CDK CLI: `npm install -g aws-cdk`
- AWS credentials configured (AWS 자격 증명 설정 완료)
- CloudFront prefix list ID for your region (해당 리전의 CloudFront 접두사 목록 ID)

## Quick Start / 빠른 시작

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

## Parameters / 파라미터

| Parameter | Default | Description |
|-----------|---------|-------------|
| `InstanceType` | `t4g.2xlarge` | EC2 instance type (ARM64 Graviton) |
| `VSCodePassword` | (required) | code-server password (min 8 chars) |
| `CloudFrontPrefixListId` | (required) | CloudFront prefix list for ALB SG |

## Architecture / 아키텍처

```
Internet -> CloudFront (HTTPS)
              |-- /awsops*       -> ALB:3000 -> EC2:3000 (Dashboard)
              |-- /awsops/_next  -> ALB:3000 (static, cached)
              |-- /*             -> ALB:80   -> EC2:8888 (VSCode)

VPC 10.254.0.0/16
  Public Subnets:  ALB, NAT Gateway
  Private Subnets: EC2, SSM VPC Endpoints
```

## Post-Deploy Steps / 배포 후 단계

After CDK deploy, continue with the setup scripts:
(CDK 배포 후, 아래 설정 스크립트를 순서대로 실행하세요:)
1. SSM into EC2: `aws ssm start-session --target INSTANCE_ID` (SSM으로 EC2 접속)
2. Run `01-install-base.sh` (Steampipe + Powerpipe) (기본 도구 설치)
3. Run `02-setup-nextjs.sh` (Next.js app) (Next.js 앱 설정)
4. Run `03-build-deploy.sh` (build and start) (빌드 및 실행)
5. Run `05-setup-cognito.sh` (update Cognito callback URLs) (Cognito 콜백 URL 업데이트)
6. Run `06-setup-agentcore.sh` (AI agent) (AI 에이전트 설정)

## Cleanup / 정리

```bash
cdk destroy --all
```
