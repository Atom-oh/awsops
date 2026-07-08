---
sidebar_position: 1
title: 仪表板
description: AWSops 主仪表板详细指南
---

import Screenshot from '@site/src/components/Screenshot';
import ArchitectureFlow from '@site/src/components/diagrams/ArchitectureFlow';

# 仪表板

仪表板是 AWSops 的主页面，可让您一目了然地掌握 AWS 及 Kubernetes 基础设施的整体状况。

<Screenshot src="/screenshots/overview/dashboard.png" alt="仪表板" />

## 系统架构

<ArchitectureFlow />

### 基础设施构成

| 组件 | 配置 |
|----------|------|
| **VPC** | 10.254.0.0/16, 2 AZ, NAT Gateway, Public + Private Subnet |
| **EC2** | t4g.2xlarge (ARM64 Graviton), 100GB GP3 EBS, Private Subnet |
| **ALB** | Internet-facing, port 80 (VSCode) / 3000 (Dashboard) |
| **CloudFront** | CACHING_DISABLED，通过 Custom Header 验证阻止直接访问 ALB |
| **Cognito** | Lambda@Edge (us-east-1) JWT 验证，HttpOnly Cookie 认证 |

### 数据层

- **Steampipe PostgreSQL** (port 9193)：380+ AWS 表，60+ K8s 表
- **缓存**：node-cache 5 分钟 TTL，批量查询 5 sequential
- **AI 引擎**：Bedrock AgentCore Runtime (Strands) + 8 Gateway（125 个 MCP 工具）

## 页面构成

仪表板由以下几个部分组成：

1. **Compute & Containers** - 计算资源摘要
2. **Network & Storage** - 网络及存储摘要
3. **Security, Monitoring & Cost** - 安全、监控、成本摘要
4. **Active Warnings** - 实时警告
5. **Charts** - 资源分布及状态图表

## StatsCard

### Compute & Containers（6 个）

| 卡片 | 显示信息 | 详情 |
|------|----------|------|
| **EC2** | 实例总数 | running / stopped 数量 |
| **Lambda** | 函数总数 | 运行时数量、long timeout 函数数量 |
| **AgentCore** | 8 GW | 125 tools, 19 Lambda, Multi-route |
| **ECR** | 仓库总数 | scan 启用数、immutable tags 数量 |
| **EKS** | 节点总数 | ready 节点、pods、deployments 数量 |
| **CloudFront** | 分配总数 | enabled、允许 HTTP 的数量 |

### Network & Storage（9 个）

| 卡片 | 显示信息 | 详情 |
|------|----------|------|
| **VPCs** | VPC 数量 | Subnets、NAT Gateway、TGW 数量 |
| **WAF** | Web ACL 数量 | 规则组、IP sets 数量 |
| **EBS** | 卷数量 | 总容量(GB)、未加密卷数量 |
| **S3 Buckets** | 存储桶数量 | public/private 区分 |
| **RDS** | 实例数量 | 总存储(GB)、Multi-AZ 数量 |
| **DynamoDB** | 表数量 | 是否为 On-demand |
| **ElastiCache** | 集群数量 | Redis/Memcached 区分、节点数量 |
| **OpenSearch** | 域数量 | VPC 域、加密状态 |
| **MSK** | 集群数量 | active 集群数量 |

### Security, Monitoring & Cost（6 个）

| 卡片 | 显示信息 | 详情 |
|------|----------|------|
| **Security Issues** | 问题总数 | Public S3, Open SG, Unencrypted EBS |
| **IAM Users** | 用户数量 | roles、groups、no MFA 数量 |
| **CW Alarms** | 告警数量 | metrics、log groups 数量 |
| **CloudTrail** | 跟踪数量 | active、multi-region、validated 数量 |
| **CIS Compliance** | 合规率(%) | alarm、skip、error 数量 |
| **Monthly Cost** | 月度费用($) | 日均费用、环比增减率 |

## 卡片点击导航

点击各 StatsCard 即可跳转到相应服务的详情页面。

| 卡片 | 跳转页面 |
|------|-----------|
| EC2 | `/ec2` |
| Lambda | `/lambda` |
| AgentCore | `/agentcore` |
| EKS | `/k8s` |
| S3 Buckets | `/s3` |
| RDS | `/rds` |
| Security Issues | `/security` |
| CIS Compliance | `/compliance` |
| Monthly Cost | `/cost`（Cost Explorer 可用时） |

:::tip 不支持 Cost Explorer 的环境
在 MSP 账户等不支持 Cost Explorer 的环境中，点击 Monthly Cost 卡片时会跳转到 `/inventory` (Resource Inventory) 页面。
:::

## Active Warnings

显示实时检测到的警告事项。

| 警告类型 | 说明 | 严重程度 |
|----------|------|--------|
| **Public S3 Buckets** | 可公开访问的 S3 存储桶 | Error（红色） |
| **IAM users without MFA** | 未设置 MFA 的 IAM 用户 | Warning（橙色） |
| **CloudWatch Alarms** | 已激活的 CloudWatch 告警 | Error（红色） |
| **Open Security Groups** | 0.0.0.0/0 入站安全组 | Warning（橙色） |
| **K8s Warning events** | Kubernetes 警告事件 | Warning（橙色） |

点击警告即可跳转到相应服务的详情页面。

## 图表

### Resource Distribution (Bar Chart)

以柱状图显示各资源类型的数量。

- EC2, Lambda, S3, RDS, ECS Tasks, DynamoDB, K8s Pods

### EC2 Instance Types (Pie Chart)

以饼图显示各 EC2 实例类型的分布。

- t3.micro、t3.small、m5.large 等前 8 个类型

### K8s Pod Status (Pie Chart)

以饼图显示各 Kubernetes Pod 状态的分布。

- Running, Pending, Failed, Succeeded

### Recent K8s Events

显示最近的 Kubernetes Warning 事件。

- Namespace、Pod 名称、Reason、Message

## 数据刷新

### 自动加载
访问页面时自动查询数据。

### 手动刷新
点击页头的刷新按钮时，将忽略缓存并查询最新数据。

### 缓存
- 数据缓存 5 分钟
- 完成 Cost 可用性检查后开始加载数据

## Cost 可用性自动检测

仪表板加载时会自动检查 Cost Explorer API 的可用性。

1. 调用 `/api/steampipe?action=cost-check` API
2. 根据响应包含/排除 Cost 相关查询
3. 不支持 Cost Explorer 时显示 "N/A"

## 库存快照

查询仪表板数据时会自动保存资源库存快照。

- 保存位置：`data/inventory/`
- 用途：Resource Inventory 页面的趋势分析

:::info AI 分析
如需对仪表板中查看的信息进行更详细的分析，请在 AI Assistant 中提问。

示例：
- "Security Issues 中有 3 个 Open SG，请详细告诉我是哪些安全组"
- "EC2 实例中有很多处于 stopped 状态，请分析一下为了节省成本是否可以将其终止"
:::

## 下一步

- [AI 助手详情](../overview/ai-assistant) - 使用 AI 分析仪表板数据
- [AgentCore 详情](../overview/agentcore) - 理解 AgentCore 架构
