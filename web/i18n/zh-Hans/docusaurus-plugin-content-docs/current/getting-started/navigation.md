---
sidebar_position: 2
title: 导航指南
description: AWSops 仪表板界面布局及导航方法
---

import Screenshot from '@site/src/components/Screenshot';

# 导航指南

AWSops 仪表板提供基于侧边栏的导航。37 个页面按 6 个分组组织，帮助您快速找到所需信息。

<Screenshot src="/screenshots/overview/dashboard.png" alt="AWSops 仪表板整体界面 — 侧边栏、页头、主内容区域" />

## 界面布局

界面大致分为 3 个区域。

### ① 侧边栏（左侧）

固定在屏幕左侧的导航区域。

- **顶部**：AWSops 徽标 + EN/韩语切换 + Sign Out 按钮
- **Account Selector**：多账户模式下的账户选择
- **中部**：6 个菜单分组（Overview、Compute、Network & CDN、Storage & DB、Monitoring、Security）
- **底部**：Cost ON/OFF 开关 + 版本信息
- 当前页面会在左侧以**青色（cyan）高亮**显示

### ② 页头（顶部）

显示在每个页面顶部的区域。

- **页面名称**：当前正在查看的页面标题
- **刷新按钮**：点击后刷新数据（忽略缓存）
- **ONLINE 状态**：服务器连接状态指示（绿色圆点 = 正常）

### ③ 主内容（中央）

显示所选页面数据的区域。

- **仪表板**：StatsCard、告警状态、图表
- **服务页面**：资源表格、详情面板、CloudWatch 指标

## 菜单分组

### Overview（4 个页面）

| 菜单 | 说明 |
|------|------|
| **Dashboard** | 全部资源摘要、20 个 StatsCard、告警状态 |
| **AI Assistant** | 基于 AI 的问答，用自然语言分析基础设施（支持多数据源关联分析） |
| **AgentCore** | AgentCore Runtime/Gateway 状态、调用统计 |
| **Accounts** | 多账户管理（添加/删除/测试，仅限管理员） |

### Compute（8 个页面）

| 菜单 | 说明 |
|------|------|
| **EC2** | EC2 实例列表及详细信息 |
| **Lambda** | Lambda 函数、运行时分布 |
| **ECS** | ECS 集群、服务、任务 |
| **ECR** | ECR 仓库、镜像 |
| **EKS** | EKS 集群概览、节点、Pod 摘要（Access Entry 状态、点击筛选、Service Resources 选项卡） |
| **EKS Explorer** | K9s 风格终端 UI（基于 Steampipe 的只读模式） |
| **ECS Container Cost** | 按 ECS Fargate 工作负载的成本分析（Container Insights + Fargate 价格） |
| **EKS Container Cost** | 按 EKS Pod 的成本分析（OpenCost 或基于 Request 的回退方案） |

:::tip EKS 子页面
在 EKS Overview 中点击统计卡片（Nodes、Pods、Deployments、Services）即可跳转到各详情页面。点击集群卡片则仅筛选该集群。
:::

### Network & CDN（4 个页面）

| 菜单 | 说明 |
|------|------|
| **VPC / Network** | VPC、Subnet、Security Group、TGW、NAT |
| **CloudFront** | CloudFront 分发状态 |
| **WAF** | WAF Web ACL、规则组 |
| **Topology** | 基础设施拓扑可视化（React Flow） |

### Storage & DB（7 个页面）

| 菜单 | 说明 |
|------|------|
| **EBS** | EBS 卷、快照、加密状态 |
| **S3** | S3 存储桶、TreeMap 可视化 |
| **RDS** | RDS 实例、CloudWatch 指标 |
| **DynamoDB** | DynamoDB 表 |
| **ElastiCache** | ElastiCache 集群（Redis/Memcached） |
| **OpenSearch** | OpenSearch 域 |
| **MSK** | MSK Kafka 集群 |

### Monitoring（8 个页面）

| 菜单 | 说明 |
|------|------|
| **Monitoring** | CPU、Memory、Network、Disk I/O 统一视图 |
| **Bedrock** | Bedrock 模型使用量、成本、令牌监控 |
| **CloudWatch** | CloudWatch 告警状态 |
| **CloudTrail** | CloudTrail 跟踪及事件 |
| **Cost** | Cost Explorer、成本分析 |
| **Resource Inventory** | 资源清单变化趋势 |
| **Datasources** | 外部数据源管理（Prometheus、Loki、Tempo、ClickHouse、Jaeger、Dynatrace、Datadog） |
| **┗ Explore** | 数据源查询执行 + AI 查询生成（PromQL、LogQL、TraceQL、SQL） |

### Security（3 个页面）

| 菜单 | 说明 |
|------|------|
| **IAM** | IAM 用户、角色、信任策略 |
| **Security** | 安全问题（Public S3、Open SG、CVE） |
| **CIS Compliance** | CIS Benchmark（v1.5 ~ v4.0） |

## Cost 开关

通过侧边栏底部的 **Cost: ON/OFF** 按钮可以启用/禁用成本相关功能。

- **ON**：显示 Cost 菜单，在仪表板中显示成本卡片
- **OFF**：隐藏 Cost 菜单（适用于 MSP 环境等不支持 Cost Explorer 的场景）

:::tip Cost Explorer 自动检测
仪表板启动时会自动检查 Cost Explorer API 的可用性。在不可用的环境中会自动切换为 OFF 状态。
:::

## 页面跳转

### 从侧边栏跳转
点击所需菜单即可跳转到相应页面。当前页面会在左侧以青色（cyan）高亮显示。

### 从仪表板卡片跳转
点击仪表板中的各个 StatsCard 即可跳转到相应服务的详情页面。

示例：
- **点击 EC2 卡片** → 跳转到 EC2 页面
- **点击 Security Issues 卡片** → 跳转到 Security 页面
- **点击 EKS 卡片** → 跳转到 EKS 页面

## 数据刷新

### 自动刷新
页面加载时会自动查询最新数据。数据缓存 5 分钟。

### 手动刷新
点击页头的刷新按钮，将忽略缓存并查询最新数据。

## 下一步

- [AI 助手快速入门](../getting-started/ai-assistant) - 使用 AI 功能
- [仪表板详解](../overview/dashboard) - 深入了解仪表板功能
