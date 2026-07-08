---
sidebar_position: 6
title: EKS Explorer
description: 使用 K9s 风格的终端 UI 探索 Kubernetes 资源
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Explorer

本页面提供 K9s 风格的终端 UI，可用于探索 Kubernetes 资源。

<Screenshot src="/screenshots/compute/eks-explorer.png" alt="EKS Explorer" />

## 主要功能

### 顶部栏
- **K9s | Explorer**: 显示当前页面
- **集群选择**: 通过下拉菜单选择集群
- **资源数量**: 当前显示的资源个数
- **Auto Refresh**: 30 秒自动刷新开关
- **Refresh**: 手动刷新按钮

### 节点标题栏（折叠/展开）
点击后显示节点列表和资源使用量：
- 各节点的 CPU/Memory 使用量条
- 显示节点数量

### 资源选项卡
通过选项卡切换 10 种 Kubernetes 资源：

| 选项卡 | 资源 | 主要列 |
|----|--------|-----------|
| Pods | Pod | NAME, NAMESPACE, STATUS, NODE, AGE |
| Deploy | Deployment | NAME, NAMESPACE, DESIRED, AVAILABLE, READY |
| SVC | Service | NAME, NAMESPACE, TYPE, CLUSTER-IP, AGE |
| RS | ReplicaSet | NAME, NAMESPACE, DESIRED, READY, AVAILABLE |
| DS | DaemonSet | NAME, NAMESPACE, DESIRED, CURRENT, READY |
| STS | StatefulSet | NAME, NAMESPACE, DESIRED, READY |
| Jobs | Job | NAME, NAMESPACE, ACTIVE, SUCCEEDED, FAILED |
| CM | ConfigMap | NAME, NAMESPACE, AGE |
| Sec | Secret | NAME, NAMESPACE, TYPE, AGE |
| PVC | PersistentVolumeClaim | NAME, NAMESPACE, STATUS, STORAGECLASS, CAPACITY |

### 过滤器
- **Search**: 文本搜索（所有字段）
- **Namespace**: 命名空间过滤
- **Status**: 状态过滤（Running、Pending 等）
- **Node**: 节点过滤（Pod 选项卡）
- **Clear**: 重置过滤器

### 分页
- 每页行数：25、50、100、200
- 页面切换：Prev / Next

### 详情面板
点击资源后，右侧会打开详情面板：
- YAML 格式的详细信息
- 按资源类型显示定制信息

### 状态栏
- 键盘快捷键提示（Tab、Enter、Esc、/）
- Auto-refresh 状态显示
- 当前资源类型和命名空间

## 使用方法

1. 在侧边栏中点击 **Compute > K8s > Explorer**
2. 在顶部选择集群
3. 点击选项卡切换资源类型
4. 使用搜索和过滤器查找所需资源
5. 点击资源查看详细信息

## 键盘快捷键

| 键 | 操作 |
|----|------|
| Tab | 切换资源选项卡 |
| Enter | 查看所选资源的详情 |
| Esc | 关闭详情面板 |
| / | 聚焦搜索框 |

## 使用技巧

:::tip 活用命名空间过滤
如果只想查看特定命名空间的资源，请使用命名空间下拉菜单。可以排除系统命名空间（kube-system），仅查看应用程序命名空间。
:::

:::tip Auto Refresh
在运维监控时启用 Auto 30s，数据会每 30 秒自动刷新一次。
:::

:::info AI 分析
可以在 AI Assistant 中使用"kube-system 命名空间的 Pod 列表"、"查找 Pending 状态的 Pod"、"分析特定节点上的 Pod"等方式进行分析。
:::

## 相关页面

- [EKS Overview](../compute/eks) - 集群整体状况
- [EKS Pods](../compute/eks-pods) - Pod 详细仪表板
- [EKS Deployments](../compute/eks-deployments) - Deployment 详情
- [EKS Services](../compute/eks-services) - Service 详情
