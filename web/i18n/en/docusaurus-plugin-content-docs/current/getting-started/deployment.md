---
sidebar_position: 4
title: Deployment Guide
description: AWSops deployment steps and requirements
---

import DeploymentPipeline from '@site/src/components/diagrams/DeploymentPipeline';

# Deployment Guide

Complete guide for deploying AWSops to a new AWS account.

<DeploymentPipeline />

## Prerequisites

| Item | Requirement |
|------|-------------|
| **AWS Account** | Appropriate IAM permissions (Admin or PowerUser) |
| **CDK CLI** | Installed locally (`npm install -g aws-cdk`) |
| **Docker** | arm64 build support (`docker buildx`) |
| **Node.js** | v20 or higher |
| **AWS CLI** | v2, profile configured |

## Deployment Steps

### Step 0: CDK Infrastructure (Local)

```bash
cd infra-cdk && cdk deploy --all
```

Resources deployed by CDK:
- **VPC**: 10.254.0.0/16, 2 AZs, NAT Gateway, Public + Private Subnets
- **EC2**: t4g.2xlarge (ARM64 Graviton), 100GB GP3, Private Subnet
- **ALB**: Internet-facing, Custom Header validation
- **CloudFront**: CACHING_DISABLED, ALB Origin
- **Cognito**: User Pool + Lambda@Edge (us-east-1)

### Step 1: Install Steampipe (EC2)

```bash
bash scripts/01-install-base.sh
```

Installs Steampipe + AWS/K8s/Trivy plugins. 380+ AWS tables available via PostgreSQL on port 9193.

### Step 2: Setup Next.js (EC2)

```bash
bash scripts/02-setup-nextjs.sh
```

Installs Next.js 14 app, registers Steampipe service, auto-detects MSP environment.

### Step 3: Production Build (EC2)

```bash
bash scripts/03-build-deploy.sh
```

Runs `npm run build` + `npm start` for production server.

### Step 5: Cognito Auth (EC2)

```bash
bash scripts/05-setup-cognito.sh
```

Creates Cognito User Pool users and configures app client.

### Step 6a-6f: AgentCore (EC2)

| Script | Description |
|--------|-------------|
| `06a-setup-agentcore-runtime.sh` | IAM role, ECR, Docker arm64 build, Runtime Endpoint |
| `06b-setup-agentcore-gateway.sh` | Create 8 Gateways (MCP) |
| `06c-setup-agentcore-tools.sh` | 19 Lambda + register 125 tools across 8 Gateways |
| `06d-setup-agentcore-interpreter.sh` | Create Code Interpreter |
| `06e-setup-agentcore-memory.sh` | Create Memory Store (365-day retention) |
| `06f-setup-opencost.sh` | Prometheus + OpenCost (EKS cost analysis) |

### Step 7: CloudFront Auth Integration (EC2)

```bash
bash scripts/07-setup-cloudfront-auth.sh
```

Connects Lambda@Edge to CloudFront viewer-request.

## Configuration File

`data/config.json` is auto-generated after deployment. For new account deployments, only update this file.

```json
{
  "costEnabled": true,
  "agentRuntimeArn": "arn:aws:bedrock-agentcore:REGION:ACCOUNT:runtime/RUNTIME_ID",
  "codeInterpreterName": "awsops_code_interpreter-XXXXX",
  "memoryId": "awsops_memory-XXXXX",
  "memoryName": "awsops_memory"
}
```

:::tip No Code Changes Required
For per-account deployment, just update `data/config.json`. No source code changes needed.
:::

## Related Pages

- [Authentication Flow](./auth) - Cognito auth details
- [AgentCore](../overview/agentcore) - AgentCore architecture details
- [Dashboard](../overview/dashboard) - System architecture overview
