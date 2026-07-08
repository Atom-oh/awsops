---
sidebar_position: 1
title: AWSops 介绍
description: AWS + Kubernetes 运维仪表板概述及主要功能
---

import Screenshot from '@site/src/components/Screenshot';

# AWSops 介绍

AWSops 是一个可实时监控和管理 AWS 及 Kubernetes 基础设施的集成运维仪表板。基于 Steampipe、Next.js 14 和 Amazon Bedrock AgentCore 构建，提供强大的数据查询和基于 AI 的分析功能。

<Screenshot src="/screenshots/overview/dashboard.png" alt="仪表板" />

## 主要功能

### 实时资源监控
- 通过 **37 个页面**一目了然地掌握 AWS 及 Kubernetes 资源状况
- EC2、Lambda、ECS、EKS、S3、RDS、VPC 等主要服务仪表板
- 实时 CloudWatch 指标集成

### 基于 AI 的分析
- 基于 **Amazon Bedrock AgentCore** 的 AI 助手
- 通过自然语言提出基础设施问题及分析请求
- 利用 8 个专业 Gateway 和 125 个 MCP 工具
- 支持 Claude Sonnet/Opus 4.6 模型

### 网络故障排查
- VPC Flow Logs 分析
- Reachability Analyzer 集成
- Transit Gateway 路由诊断
- 网络拓扑可视化

### 安全与合规
- 支持 CIS Benchmark v1.5 ~ v4.0（431 个控制项）
- IAM 用户/角色/策略分析
- 安全问题自动检测（Public S3、Open SG、未加密 EBS）

### 成本管理
- Cost Explorer 集成
- 按服务/按区域的成本分析
- 按 ECS/EKS 容器工作负载的成本追踪

## 架构

<div style={{background: 'white', padding: '16px', borderRadius: '8px', marginBottom: '1rem'}}>

![系统架构](/img/architecture.png)

</div>

### 基础设施构成

| 组件 | 配置 | 说明 |
|----------|------|------|
| **CloudFront** | CACHING_DISABLED | 通过 Custom Header 验证阻止对 ALB 的直接访问 |
| **Lambda@Edge** | us-east-1, Node.js 20 | JWT 验证、OAuth2 回调、Cookie 管理 |
| **Cognito** | User Pool + Hosted UI | 邮箱/用户名登录、HttpOnly Cookie 认证 |
| **ALB** | Internet-facing | Port 80 (VSCode) / 3000 (Dashboard) |
| **EC2** | t4g.2xlarge (ARM64 Graviton) | 100GB GP3 EBS, Private Subnet |
| **VPC** | 10.10.0.0/16, 2 AZ | NAT Gateway, Public + Private Subnet |

### Next.js 14 应用程序

| 项目 | 数量 |
|------|------|
| **App Router** | 8 个 |
| **Pages** | 37 个 |
| **API Routes** | 13 个 |
| **SSE Streaming** | AI 响应实时流式传输 |

### 数据层

| 组件 | 说明 |
|----------|------|
| **Steampipe** | 内置 PostgreSQL (port 9193) |
| **AWS Plugin** | 380+ 张表（EC2、Lambda、S3、RDS、VPC、IAM 等） |
| **K8s Plugin** | 60+ 张表（Pods、Nodes、Deployments 等） |
| **AWS CLI v2** | CloudWatch per-metric-data, execFileSync |
| **kubectl** | `/kube/config`，基于 EKS Access Entry 的认证 |
| **缓存** | node-cache 5 分钟 TTL，批量查询 5 sequential |

### 数据目录

| 路径 | 用途 |
|------|------|
| `data/config.json` | 应用配置（AgentCore ARN、Cost 启用等） |
| `data/memory/` | AI 对话历史（按用户分离） |
| `data/inventory/` | 资源清单快照 |
| `data/cost/` | Cost 数据快照（回退） |

### AI 引擎 — AgentCore

在 EC2 上构建 Docker arm64 镜像并推送到 ECR，然后在 AgentCore 托管服务中运行。

| 组件 | 说明 |
|----------|------|
| **Bedrock Model** | Claude Sonnet/Opus 4.6 |
| **Runtime** | Strands Agent Framework (Docker arm64, ECR) |
| **Code Interpreter** | Python 沙箱（pandas、matplotlib 等） |
| **Memory** | 对话历史存储（保留 365 天） |

### AI 路由（10 级优先级）

根据问题类型自动路由到最合适的 Gateway：

| 优先级 | 路由 | 目标 |
|----------|--------|------|
| 1 | `code` | Code Interpreter — Python 代码执行 |
| 2 | `network` | Network Gateway — VPC, TGW, VPN, Firewall |
| 3 | `container` | Container Gateway — EKS, ECS, Istio |
| 4 | `iac` | IaC Gateway — CDK, CloudFormation, Terraform |
| 5 | `data` | Data Gateway — DynamoDB, RDS, ElastiCache, MSK |
| 6 | `security` | Security Gateway — IAM、策略模拟 |
| 7 | `monitoring` | Monitoring Gateway — CloudWatch, CloudTrail |
| 8 | `cost` | Cost Gateway — 成本分析、预测、预算 |
| 9 | `aws-data` | Steampipe SQL — 列表/状态/配置分析 |
| 10 | `general` | Ops Gateway — AWS 文档、API 调用、回退 |

### 8 Gateway × 125 MCP 工具

每个 Gateway 通过 Lambda 函数提供专业工具：

| Gateway | 工具数 | Lambda | 主要功能 |
|---------|---------|--------|-----------|
| **Network** | 17 | Lambda × 5 | VPC, TGW, Firewall, Reachability, Flow Logs |
| **Container** | 24 | Lambda × 3 | EKS、ECS、Istio 服务网格 |
| **IaC** | 12 | Lambda × 2 | CDK, CloudFormation, Terraform |
| **Data** | 24 | Lambda × 4 | DynamoDB, RDS/Aurora, ElastiCache, MSK |
| **Security** | 14 | Lambda × 1 | IAM 用户/角色/策略、Access Key |
| **Monitoring** | 16 | Lambda × 2 | CloudWatch Metrics/Logs, CloudTrail |
| **Cost** | 9 | Lambda × 1 | 成本/用量、预测、预算 |
| **Ops** | 9 | Lambda × 1 | AWS 文档、API 调用、Steampipe SQL |
| **合计** | **125** | **19** | |

:::tip 多路由
对于复杂的问题，会并行调用多个 Gateway 以提供综合性回答。例如："请诊断 EKS 集群的网络问题" → 同时调用 Container + Network Gateway。
:::

## 支持的数据源

### AWS（380+ 张表）
通过 Steampipe AWS 插件实时查询以下服务的数据：

| 类别 | 服务 |
|---------|--------|
| Compute | EC2, Lambda, ECS, ECR, Auto Scaling |
| Network | VPC, Subnet, Security Group, Transit Gateway, VPN, CloudFront, WAF |
| Storage | S3, EBS, EFS |
| Database | RDS, DynamoDB, ElastiCache, OpenSearch, MSK |
| Security | IAM, KMS, Secrets Manager |
| Monitoring | CloudWatch, CloudTrail |
| Cost | Cost Explorer, Budgets |

### 外部数据源（7 种）
将外部可观测性平台作为数据源进行集成，实现统一分析：

| 类别 | 数据源 |
|---------|-----------|
| Metrics | Prometheus, Dynatrace, Datadog |
| Logs | Loki, ClickHouse |
| Traces | Tempo, Jaeger |

### Kubernetes（60+ 张表）
连接到 EKS 集群，监控以下资源：

- Pods, Nodes, Deployments, Services
- ConfigMaps, Secrets, ServiceAccounts
- Events, Metrics

## 技术栈

| 组成部分 | 技术 |
|---------|------|
| Frontend | Next.js 14 (App Router), Tailwind CSS, Recharts, React Flow |
| Backend | Steampipe（内置 PostgreSQL port 9193）, Node.js |
| AI Engine | Amazon Bedrock (Claude Sonnet/Opus 4.6), AgentCore Runtime (Strands) |
| AI Tools | 8 Gateway、125 个 MCP 工具、19 Lambda、Code Interpreter、Memory |
| 认证 | Amazon Cognito, Lambda@Edge (us-east-1) |
| 基础设施 | AWS CDK, CloudFront, ALB, EC2 (t4g.2xlarge ARM64) |

## 后续步骤

- [登录指南](./getting-started/login) - 仪表板访问方法
- [导航指南](./getting-started/navigation) - 了解界面构成
- [AI 助手快速入门](./getting-started/ai-assistant) - 使用 AI 功能
- [部署指南](./getting-started/deployment) - 部署到新账户
- [认证流程](./getting-started/auth) - Cognito 认证详情
- [AgentCore 详情](./overview/agentcore) - Gateway 及工具完整列表
