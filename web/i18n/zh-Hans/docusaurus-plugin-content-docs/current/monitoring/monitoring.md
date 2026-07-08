---
sidebar_position: 1
title: 监控概览
description: 实时监控 EC2、RDS、EBS、K8s 资源的 CPU、内存、网络、Disk I/O 指标。
---

import Screenshot from '@site/src/components/Screenshot';

# Monitoring Overview

本页面可在一个界面上全面监控整个 AWS 基础设施的性能指标。

<Screenshot src="/screenshots/monitoring/monitoring.png" alt="Monitoring" />

## 主要功能

### 综合仪表板
- **EC2 CPU**: 各实例的平均/最大 CPU 使用率
- **Network I/O**: 各实例的网络 In/Out 流量 (MB/h)
- **K8s Memory**: 各节点的内存容量、分配量、Pod 数量
- **EBS IOPS**: 各卷的 Read/Write IOPS
- **RDS**: 数据库 CPU、连接数、FreeableMemory

### 按选项卡查看详情
| 选项卡 | 内容 |
|---|------|
| EC2 CPU | 各实例 CPU 使用率表格，点击后显示时间序列图表 |
| Network | Network In/Out 流量，24 小时趋势图 |
| Memory | K8s 节点资源 + RDS FreeableMemory |
| EBS IOPS | 各卷的 Read IOPS，按小时趋势 |
| RDS | CPU、连接数、按日趋势 |

### 实例详细指标
点击 EC2 实例行即可进入详细指标视图：
- CPUUtilization、NetworkIn/Out、DiskReadOps、DiskWriteOps
- 时间范围过滤：1h、6h、24h、7d、30d
- 显示各指标的平均值/最大值

## 使用方法

1. **选择选项卡**: 选择要监控的资源类型（EC2 CPU、Network、Memory、EBS、RDS）
2. **表格排序**: 点击列标题进行排序
3. **查看详情**: 点击行后显示滑出面板或详细视图
4. **刷新**: 点击右上角刷新按钮获取最新数据

:::tip 性能阈值颜色
- **绿色**: 正常 (CPU < 50%)
- **橙色**: 注意 (CPU 50-80%)
- **红色**: 警告 (CPU > 80%)
:::

## 使用技巧

### 识别高 CPU 实例
可在顶部 StatsCard 的 "High CPU (>80%)" 卡片中立即确认。点击数字即可按对应实例进行过滤。

### 查看 K8s 内存预留率
请在 Memory 选项卡中查看 K8s 节点的 Reserved % 列。如果系统预留内存过高，可能会影响 Pod 调度。

### RDS 内存监控
点击 RDS 行即可查看 FreeableMemory 图表。如果该值持续偏低，可能需要扩大实例规格。

:::info CloudWatch 详细监控
EC2 详细指标仅在启用了 CloudWatch 详细监控的实例上提供 1 分钟粒度的数据。基础监控为 5 分钟粒度。
:::

## AI 分析技巧

在 AI 助手中使用 Monitoring Gateway（17 个工具）可以进行更深入的分析：

- "分析一下 EC2 CPU 使用率高的实例的原因"
- "分析一下过去 7 天的网络流量模式"
- "找出 RDS 连接数激增的原因"
- "告诉我 K8s 节点内存不足的预计时间点"

## 相关页面

- [CloudWatch](./monitoring/cloudwatch) - 告警管理
- [Cost Explorer](./monitoring/cost) - 成本分析
- [Resource Inventory](./monitoring/inventory) - 资源数量趋势
