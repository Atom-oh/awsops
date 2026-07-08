---
sidebar_position: 1
title: EC2 实例
description: EC2 实例列表、状态监控、详细信息查看
---

import Screenshot from '@site/src/components/Screenshot';

# EC2 实例

本页面用于实时监控 EC2 实例的状态并查看详细信息。

<Screenshot src="/screenshots/compute/ec2.png" alt="EC2 实例" />

## 主要功能

### 统计卡片
页面顶部的 4 个 StatsCard 展示核心指标：
- **Running**: 运行中的实例数量（绿色）
- **Stopped**: 已停止的实例数量（红色）
- **Total vCPUs**: 全部 vCPU 总和（青色）
- **Instance Types**: 正在使用的实例类型种类数（紫色）

### 可视化图表
- **Instance Type Distribution**: 以饼图展示各实例类型的分布
- **Instance Status**: 以柱状图展示各状态的实例数量

### 实例列表表格
以表格形式展示所有 EC2 实例：
- Instance ID、Name、Type、State、Public/Private IP、VPC、Launch Time
- 根据状态显示不同颜色的 StatusBadge（running=绿色，stopped=红色）

### 筛选与搜索
- **搜索框**: 在 ID、Name、IP 等所有字段中进行文本搜索
- **State 筛选**: 按 running、stopped 等状态筛选
- **Type 筛选**: 按 t3.micro、m5.large 等实例类型筛选
- **VPC 筛选**: 按 VPC ID 筛选
- **Clear all**: 重置所有筛选条件

### 详情面板
在表格中点击实例行后，右侧会打开详情面板：
- **Instance 部分**: Instance ID、AMI、Architecture、Platform、Key Pair、IAM Role 等
- **Compute 部分**: vCPUs、Cores、Threads/Core、Memory、Network Performance
- **Network 部分**: VPC、Subnet、AZ、Private/Public IP、DNS、Network Interfaces
- **Security Groups 部分**: 关联的安全组列表
- **Storage 部分**: Root Device、Block Device Mappings
- **Tags 部分**: 实例上配置的标签列表

## 使用方法

1. 在侧边栏中点击 **Compute > EC2**
2. 通过顶部统计卡片了解整体状况
3. 使用筛选功能找到所需的实例
4. 在表格中点击实例以查看详细信息
5. 点击刷新按钮可加载最新数据

## 使用技巧

:::tip 快速搜索
在搜索框中只输入 IP 地址的一部分，也能快速找到对应的实例。
:::

:::tip 组合筛选
同时使用多个筛选条件可以更精确地查找实例。例如，可以只查看"处于 running 状态的 t3.large 实例"。
:::

:::info AI 分析
可以在 AI Assistant 中通过"显示 EC2 实例列表"、"有多少个 running 状态的实例？"等提问进行分析。
:::

## 相关页面

- [VPC](../network/vpc) - 查看网络配置
- [EBS](../storage/ebs) - 查看关联的卷
- [Monitoring](../monitoring) - 查看 CPU/内存指标
