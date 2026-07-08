---
sidebar_position: 11
title: ECS Container Cost
description: ECS Fargate 任务成本分析，CloudWatch Container Insights 指标
---

import Screenshot from '@site/src/components/Screenshot';

# ECS Container Cost

用于分析 ECS Fargate 任务成本的页面。基于 Fargate 价格和 CloudWatch Container Insights 指标计算成本。

<Screenshot src="/screenshots/compute/ecs-container-cost.png" alt="ECS Container Cost" />

## 主要功能

### 统计卡片
- **Daily Cost (ECS)**: 每日总成本（青色）
- **Monthly Estimate**: 月度预估成本（绿色）
- **Running Tasks**: 运行中的任务数 - 区分 Fargate/EC2（紫色）
- **Top Cost Service**: 成本最高的服务（橙色）

### Service Cost Distribution 图表
以饼图展示各服务的每日成本分布

### Cost by Service (CPU vs Memory) 图表
以堆叠柱状图比较各服务的 CPU 成本和 Memory 成本

### ECS Tasks 表格
| 列 | 说明 |
|------|------|
| Cluster | 集群名称 |
| Service | 服务名称 |
| Task ID | 任务 ID（前 12 位） |
| Type | 启动类型（FARGATE/EC2） |
| CPU (units) | CPU 单元及 vCPU 换算值 |
| Memory (MB) | 内存及 GB 换算值 |
| Daily Cost | 每日成本（仅限 Fargate） |
| AZ | 可用区 |

## 成本计算方式

### Fargate 价格 (ap-northeast-2)
| 资源 | 单价 | 计费单位 |
|--------|------|-----------|
| vCPU | $0.04048 | per vCPU-hour |
| Memory | $0.004445 | per GB-hour |
| Ephemeral Storage (>20GB) | $0.000111 | per GB-hour |

### 计算公式
```
CPU Cost = (CPU Units / 1024) x $0.04048/hr x 24hr
Memory Cost = (Memory MB / 1024) x $0.004445/hr x 24hr
Daily Cost = CPU Cost + Memory Cost
Monthly Estimate = Daily Cost x 30
```

### 计算示例
Fargate Task: 512 CPU units (0.5 vCPU) + 1024 MB (1 GB)
- CPU: 0.5 vCPU x $0.04048/hr x 24hr = **$0.486/day**
- Memory: 1 GB x $0.004445/hr x 24hr = **$0.107/day**
- Total: **$0.593/day ($17.78/month)**

## 使用方法

1. 在侧边栏中点击 **Compute > Container Cost**
2. 通过统计卡片了解整体成本状况
3. 在图表中识别成本较高的服务
4. 在表格中查看各任务的详细成本
5. 展开 "Cost Calculation Basis" 部分查看计算依据

## 支持范围

| 项目 | 支持 |
|------|------|
| Fargate Launch Type | O（支持成本计算） |
| EC2 Launch Type | X（需要节点成本分摊，暂不支持） |
| Spot Fargate | -（按 On-Demand 价格计算） |

## 使用技巧

:::tip EC2 Launch Type
EC2 类型的任务显示为 "N/A (EC2)"。EC2 成本需要进行节点成本分摊，目前暂不支持。
:::

:::tip 成本优化
如果在 CPU vs Memory 图表中某一侧明显偏高，请考虑调整任务定义。Fargate 的 CPU 与 Memory 组合是受限的。
:::

:::tip 修改价格设置
可以在 `data/config.json` 的 `fargatePricing` 字段中修改各区域的价格。
:::

:::info AI 分析
可以在 AI Assistant 中使用"ECS 成本分析"、"成本最高的服务"、"Fargate 成本优化方案"等提问进行分析。
:::

## 相关页面

- [ECS](../compute/ecs) - ECS 集群及服务状态
- [EKS Container Cost](../compute/eks-container-cost) - EKS Pod 成本分析
- [Cost](../monitoring/cost) - 整体 AWS 成本分析
