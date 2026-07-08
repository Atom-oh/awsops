---
sidebar_position: 8
title: EKS Nodes
description: Kubernetes 节点列表、容量、已分配资源与状态
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Nodes

本页面用于详细查看 Kubernetes 节点的容量、可分配资源以及 Pod 请求量。

<Screenshot src="/screenshots/compute/eks-nodes.png" alt="EKS Nodes" />

## 主要功能

### 统计卡片
- **Total Nodes**: 节点总数（青色）
- **Ready**: 处于 Ready 状态的节点数（绿色）
- **Total CPU**: 全部 vCPU 容量合计（紫色）
- **Total Memory**: 全部内存容量合计（橙色）

### CPU Usage per Node 图表
以三段式条形图展示各节点的 CPU 资源状态：
- **Requested**（青色/橙色/红色）：Pod 请求的 CPU
- **Available**（绿色半透明）：可额外分配的 CPU
- **System Reserved**（灰色）：系统预留的 CPU

针对每个节点显示：
- 节点名称、Pod 请求量 / 总容量、百分比
- Pod 数量、请求 vCPU、可用 vCPU、预留 vCPU

### Memory Usage per Node 图表
以相同的三段式条形图展示各节点的 Memory 资源状态：
- **Requested**（紫色/橙色/红色）：Pod 请求的 Memory
- **Available**（绿色半透明）：可额外分配的 Memory
- **System Reserved**（灰色）：系统预留的 Memory

### 容量图表
- **CPU Capacity per Node (vCPU)**: 各节点 CPU 容量条形图
- **Memory Capacity per Node (GiB)**: 各节点内存容量条形图

### 节点表格
| 列 | 说明 |
|------|------|
| Name | 节点名称 |
| Status | Ready / NotReady |
| CPU Capacity | 总 CPU 容量 |
| Memory Capacity | 总内存容量 |
| Allocatable CPU | 可分配的 CPU |
| Allocatable Memory | 可分配的内存 |
| Created | 创建时间 |

## 理解资源概念

![节点资源层级](/diagrams/eks-node-resources.png)

| 术语 | 说明 |
|------|------|
| Capacity | 节点的全部物理资源 |
| Allocatable | 可分配给 Pod 的资源（Capacity - System Reserved） |
| Requested | 当前所有 Pod 请求的资源合计 |
| Available | 可额外分配的资源（Allocatable - Requested） |
| System Reserved | 为 kubelet、OS 等系统预留的资源 |

## 使用方法

1. 在侧边栏中点击 **Compute > K8s > Nodes**
2. 通过统计卡片了解整体节点状况
3. 在 CPU/Memory Usage 图表中识别资源使用率较高的节点
4. 对使用率达到 80% 以上（红色）的节点考虑扩容
5. 在表格中查看各节点的详细容量

## 使用技巧

:::tip 资源使用率阈值
- **80% 以上（红色）**: 需要立即处理 - 增加节点或重新调度 Pod
- **50-80%（橙色）**: 需要监控 - 关注增长趋势
- **50% 以下（青色/紫色）**: 正常 - 资源仍有余量
:::

:::tip Available vs Capacity
Available 可能为负数。这表示 Pod 仅设置了 Request 而未设置 Limit，处于超额分配（overcommit）状态。
:::

:::info AI 分析
可以在 AI Assistant 中使用"节点资源使用量"、"CPU 使用率 80% 以上的节点"、"分析是否需要节点扩容"等提问进行分析。
:::

## 相关页面

- [EKS Overview](../compute/eks) - 集群整体状况
- [EKS Pods](../compute/eks-pods) - 查看 Pod 状态
- [EC2](../compute/ec2) - 节点底层的 EC2 实例
- [EKS Container Cost](../compute/eks-container-cost) - 节点/Pod 成本分析
