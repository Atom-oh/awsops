---
sidebar_position: 4
title: Cost Explorer
description: 按服务、按日、按月分析 AWS 成本并掌握趋势。
---

import Screenshot from '@site/src/components/Screenshot';

# Cost Explorer

本页面用于从多个视角分析和可视化 AWS 成本数据。

<Screenshot src="/screenshots/monitoring/cost.png" alt="Cost" />

## 主要功能

### 成本摘要
- **This Month**: 本月累计成本
- **Last Month**: 上月总成本
- **Projected**: 月末预计成本（基于当前日期估算）
- **Daily Avg**: 日均成本
- **MoM Change**: 环比（较上月）变化率
- **Services**: 产生成本的服务数量

### 时间范围筛选
| 选项 | 说明 |
|------|------|
| This Month | 仅本月 |
| 3 Months | 最近 3 个月 |
| 6 Months | 最近 6 个月 |
| 1 Year | 最近 1 年 |

### 服务筛选
可以只选择特定服务进行分析。选择多个服务时，将显示这些服务的合计值。

### 可视化
- **Daily Cost Trend**: 最近 30 天的每日成本走势
- **Monthly Cost Trend**: 每月成本走势
- **Cost by Service (Top 8)**: 前 8 个服务占比饼图
- **Top 10 Services**: 前 10 个服务柱状图

### 服务详情
点击服务行后，可在滑出面板中查看：
- 各服务总成本
- 每月成本走势折线图
- 每月明细

## 使用方法

1. **选择时间范围**: 选择要分析的时间范围（1m、3m、6m、12m）
2. **服务筛选**: 通过 Services 按钮仅筛选特定服务
3. **查看图表**: 查看成本走势及各服务分布
4. **详细分析**: 点击服务行查看每月明细

:::tip MSP 环境自动检测
在 Managed Service Provider（MSP）环境中，Cost Explorer API 的访问可能受到限制。AWSops 会自动检测这种情况并显示替代数据。
:::

## 使用技巧

### 定位成本激增原因
1. 当 MoM Change 较高时（>10%），在服务表格中查看 Change 列
2. 点击 Change 超过 20% 的服务，查看其每月走势
3. 如果某个月出现激增，检查该时间段的资源变更记录

### 预算管理
通过 Projected 值查看月末预计成本。如果预计会超出预算：
- 清理未使用的资源
- 评估 Reserved Instance/Savings Plans
- 优化资源规格

### 识别成本优化对象
在 Share 列中优先将成本占比较高的服务作为优化对象进行评估。

:::info 不支持 Cost Explorer 的环境
在 Cost Explorer 被禁用的环境中，将显示快照数据。页面会显示 "Showing cached data" 横幅，并同时显示最后一次缓存的时间点。
:::

### costEnabled 开关
通过侧边栏底部的 **Cost** 开关可以启用或禁用 Cost Explorer 功能。在 MSP 等环境中若想减少 API 调用，请将其禁用。

## AI 分析技巧

在 AI 助手中利用 Cost Gateway（11 个工具）的提问示例：

- "分析一下本月成本增加的原因"
- "推荐 EC2 成本优化方案"
- "计算转换为 Reserved Instance 后的节省效果"
- "展示未来 3 个月的各服务成本预测"
- "按标签分析成本"

## 相关页面

- [Resource Inventory](../monitoring/inventory) - 资源数量及成本影响
- [ECS Container Cost](../compute/ecs-container-cost) - ECS 容器成本
- [EKS Container Cost](../compute/eks-container-cost) - EKS 容器成本
