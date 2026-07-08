---
sidebar_position: 3
title: ECS
description: ECS 集群、服务、任务监控
---

import Screenshot from '@site/src/components/Screenshot';

# ECS (Elastic Container Service)

用于监控 ECS 集群、服务和任务状态的页面。

<Screenshot src="/screenshots/compute/ecs.png" alt="ECS" />

## 主要功能

### 统计卡片
- **Clusters**: ECS 集群总数（青色）
- **Services**: 服务总数（紫色）
- **Tasks**: 运行中的任务数（绿色）
- **Container Instances**: EC2 容器实例数（橙色）

### 可视化图表
- **Running Tasks per Cluster**: 按集群显示运行中任务数的饼图

### 集群表格
| 列 | 说明 |
|------|------|
| Cluster Name | 集群名称 |
| Status | 状态（ACTIVE、INACTIVE） |
| Running Tasks | 运行中的任务数 |
| Pending Tasks | 等待中的任务数 |
| Active Services | 活跃服务数 |
| Container Instances | 容器实例数 |
| Region | 区域 |

### 服务表格
| 列 | 说明 |
|------|------|
| Service Name | 服务名称 |
| Status | 状态（ACTIVE、DRAINING） |
| Desired | 期望任务数 |
| Running | 运行中的任务数 |
| Pending | 等待中的任务数 |
| Launch Type | 启动类型（FARGATE、EC2） |
| Strategy | 调度策略 |

### 集群详情面板
点击集群即可查看详细信息：
- **Cluster 部分**: Name、ARN、Status、Tasks、Services、Container Instances
- **Settings 部分**: 集群设置（Container Insights 等）
- **Tags 部分**: 集群标签

## 使用方法

1. 在侧边栏点击 **Compute > ECS**
2. 通过顶部统计卡片了解 ECS 整体状况
3. 在 Clusters 表格中查看各集群的状态
4. 在 Services 表格中对比各服务的 Desired 与 Running 任务数
5. 点击集群查看详细设置

## Fargate vs EC2 Launch Type

| 类别 | Fargate | EC2 |
|------|---------|-----|
| 基础设施管理 | 无服务器（AWS 托管） | 需要自行管理 |
| 成本 | 基于 vCPU/Memory | EC2 实例费用 |
| 扩缩容 | 自动 | 需要配置 Auto Scaling |
| 成本分析 | 支持 Container Cost 页面 | 计划于 Phase 2 |

## 使用技巧

:::tip 检查服务状态
在 Services 表格中，如果 Running 小于 Desired，任务部署可能存在问题。请检查任务失败的原因。
:::

:::tip 监控 Pending Tasks
如果 Pending Tasks 长时间不消失，可以怀疑资源不足或调度问题。
:::

:::info AI 分析
在 AI Assistant 中可以使用"ECS 集群列表"、"显示 Fargate 服务"、"分析任务部署失败原因"等方式进行分析。
:::

## 相关页面

- [ECR](../compute/ecr) - 容器镜像仓库
- [ECS Container Cost](../compute/ecs-container-cost) - ECS 任务成本分析
- [VPC](../network/vpc) - ECS 网络配置
