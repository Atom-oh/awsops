---
sidebar_position: 2
title: Bedrock
description: Amazon Bedrock 模型使用量、成本、Token 监控
---

# Bedrock Monitoring

这是一个实时监控 Amazon Bedrock 各模型使用量、Token 成本以及 Prompt Caching 节省效果的仪表板。

import Screenshot from '@site/src/components/Screenshot';

<Screenshot src="/screenshots/monitoring/bedrock.png" alt="Bedrock Monitoring" />

## 主要功能

### 统计卡片（8 个）

| 卡片 | 说明 |
|------|------|
| Total Cost | 所选时间段内所有模型成本的总和 |
| Invocations | 模型调用总次数 |
| Input Tokens | 输入 Token 总数 |
| Output Tokens | 输出 Token 总数 |
| Avg Latency | 平均响应延迟时间（秒） |
| Errors | 客户端（4xx）+ 服务器（5xx）错误总数 |
| Cache Savings | 通过 Prompt Caching 节省的成本 + 缓存命中率（%） |
| Models Used | 时间段内使用的模型数量 |

### 图表（3 个）

- **Cost by Model**（饼图）：各模型的成本占比
- **Invocations by Model**（柱状图）：各模型调用次数对比
- **Token Usage Over Time**（折线图）：按时间段的 Token 使用趋势

### Account Total 与 AWSops 使用量对比

将整个账户（基于 CloudWatch）与 AWSops 应用内部的使用量并排比较：

- **Account Total**：从 CloudWatch `AWS/Bedrock` 命名空间收集的整个账户的 Invocations、Input/Output Tokens 以及估算成本
- **AWSops App**：通过仪表板 AI 助手产生的累计调用次数、Token 使用量、各模型分布

### Prompt Caching 摘要

可以一目了然地查看已启用 Prompt Caching 的模型的缓存效果：
- Cache Read/Write Token 数量
- 缓存命中率（%）
- 缓存成本及节省金额

### 各模型详细信息

在表格中点击模型行，将打开一个滑动面板：
- **Cost Breakdown**：Input/Output/Cache Read/Cache Write 成本明细
- **Usage**：Invocations、Token 数量、延迟时间、错误数量
- **Pricing**：各模型每 1M Token 的价格信息
- **时间序列图表**：调用趋势、Token 使用趋势

### 时间范围选择

使用右上角的时间范围按钮更改查询时间段：
- **1h**：最近 1 小时（5 分钟间隔）
- **6h**：最近 6 小时（5 分钟间隔）
- **24h**：最近 24 小时（1 小时间隔）
- **7d**：最近 7 天（1 天间隔）— 默认值
- **30d**：最近 30 天（1 天间隔）

## AI 页面 Token 成本显示

在 AI 助手页面（`/ai`）中，每个响应都会显示 Token 使用量和成本：
- Input/Output Token 数量
- 基于各模型价格的成本计算
- 使用与 Bedrock 仪表板相同的价格表

## 数据源

- **CloudWatch**：`AWS/Bedrock` 命名空间中的 `Invocations`、`InputTokenCount`、`OutputTokenCount`、`InvocationLatency`、`InvocationClientErrors`、`InvocationServerErrors`、`CacheReadInputTokenCount`、`CacheWriteInputTokenCount` 指标
- **AWSops 统计**：`agentcore-stats.ts` 中的累计调用/Token 数据

## 使用技巧

:::tip 成本优化
如果 Prompt Caching 命中率较低，可以将重复的系统提示词或上下文构造成可缓存的形式，从而大幅降低成本。
:::

:::info Cross-Region Inference
跨区域推理模型 ID（例如 `us.anthropic.claude-*`）也会被自动识别并应用正确的价格。
:::

## 相关页面

- [Monitoring Overview](./monitoring.md) - 基础设施性能监控
- [Cost Explorer](./cost.md) - AWS 整体成本分析
- [AI Assistant](../overview/ai-assistant.md) - AI 助手使用指南
