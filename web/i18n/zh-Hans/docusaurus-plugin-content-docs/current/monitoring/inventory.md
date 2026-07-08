---
sidebar_position: 5
title: Resource Inventory
description: 跟踪 AWS 资源数量的变化趋势并估算成本影响。
---

import Screenshot from '@site/src/components/Screenshot';

# Resource Inventory

本页面用于按天跟踪 AWS 资源数量的变化，并估算其成本影响。

<Screenshot src="/screenshots/monitoring/inventory.png" alt="Inventory" />

## 主要功能

### 汇总统计
- **Resource Types**: 正在跟踪的资源类型数量
- **Total Count**: 资源总数
- **7d Net Change**: 7 天内的净变化量

### 资源趋势图表
- 通过多折线图可视化各资源类型的数量趋势
- 时间范围切换：30 天 / 90 天
- 通过资源类型开关选择要显示的资源

### Core Resources（默认显示）
- EC2 Instances
- RDS Instances
- S3 Buckets
- EBS Volumes
- Lambda Functions

### Other Resources
- VPCs, Subnets, NAT Gateways
- ALBs, NLBs, Route Tables
- IAM Users, IAM Roles
- ECS Tasks, ECS Services
- DynamoDB Tables
- EKS Nodes, K8s Pods, K8s Deployments
- ElastiCache Clusters
- CloudFront Distributions
- WAF Web ACLs
- ECR Repositories
- Public S3 Buckets, Open Security Groups, Unencrypted EBS

### 资源表格
| 列 | 说明 |
|------|------|
| Resource | 资源类型 |
| Current | 当前数量 |
| 7d Ago | 7 天前的数量 |
| 30d Ago | 30 天前的数量 |
| 7d Change | 7 天内的变化量及变化率 |
| 30d Change | 30 天内的变化量及变化率 |

### 成本影响估算
根据资源数量的变化估算每月的成本影响：
- RDS Instances: $200/月（估算）
- ElastiCache Clusters: $150/月
- EKS Nodes: $100/月
- NAT Gateways: $45/月
- EC2 Instances: $80/月
- 其他资源按各自权重计算

## 使用方法

1. **查看趋势**: 在图表中查看资源数量的变化模式
2. **更改时间范围**: 通过 30d/90d 切换调整分析周期
3. **选择资源**: 通过切换按钮仅显示关注的资源
4. **分析表格**: 查看详细数值及变化率
5. **成本影响**: 查看底部的成本估算部分

:::tip 基于快照的数据
Resource Inventory 会在仪表板加载时自动保存快照。由于无需额外的 API 查询即可积累历史数据，因此不会产生性能影响。
:::

## 使用技巧

### 跟踪资源增长
请关注 7d Change 或 30d Change 列中以橙色（增加）显示的资源。意料之外的增长可能是成本骤增的原因。

### 监控安全相关资源
请注意以下资源的变化：
- **Public S3 Buckets**: 增加时存在数据泄露风险
- **Open Security Groups**: 增加时存在安全漏洞
- **Unencrypted EBS**: 合规性问题

### 解读成本影响
在 Cost Impact Estimation 部分中：
- 正数（+）：预计成本增加
- 负数（-）：预计成本减少

实际成本可能因实例类型、使用量等因素而有所不同。

:::info 数据保留
快照数据保存在 `data/inventory/` 目录中。超过 90 天的数据将被排除在分析之外，但文件会被保留。
:::

## AI 分析技巧

利用 AI 助手的提问示例：

- "分析一下过去 30 天内增长最多的资源"
- "如果这种资源增长趋势持续下去，每月成本会是多少？"
- "总结一下安全相关资源的变化"
- "推荐需要清理的资源项目"

## 相关页面

- [Cost Explorer](../monitoring/cost) - 实际成本分析
- [Security Overview](../security) - 安全资源详情
- [Monitoring Overview](../monitoring) - 性能监控
