---
sidebar_position: 5
---

import Screenshot from '@site/src/components/Screenshot';

# ElastiCache

监控 ElastiCache 集群（Valkey、Redis、Memcached）并查看性能指标。

<Screenshot src="/screenshots/storage/elasticache.png" alt="ElastiCache" />

## 主要功能

### 统计卡片
- **Clusters**: 集群总数（包含 Replication Group 数量）
- **Total Nodes**: 节点总数
- **Valkey**: Valkey 引擎集群数量
- **Redis**: Redis 引擎集群数量
- **Memcached**: Memcached 引擎集群数量
- **Repl Groups**: Replication Group 数量
- **Node Types**: 使用中的节点类型数量

### 可视化图表
- **Engine Distribution**: 按 Valkey、Redis、Memcached 引擎的分布
- **Node Type Distribution**: 按节点类型的分布

### Cache Nodes 指标表格
从 CloudWatch 采集的实时指标：
- **Cluster ID**: 集群标识符
- **Engine**: 引擎类型（以颜色区分）
- **Node ID**: 节点标识符
- **Status**: 节点状态
- **CPU**: CPU 使用率
- **Engine CPU**: 引擎 CPU 使用率
- **Memory**: 可用内存
- **Network In/Out**: 网络流量
- **Connections**: 当前连接数
- **AZ**: 可用区
- **Endpoint**: 节点端点

### 详情面板
点击集群后可查看的信息：
- 集群 ID、ARN、引擎、版本
- 节点类型、状态、节点数量
- Replication Group 信息
- 网络设置（子网组、AZ）
- 安全设置（At-Rest/Transit 加密、Auth Token）
- 配置设置（快照保留、维护窗口）
- Security Group 及入站规则
- CloudWatch 指标图表

## 使用方法

### 查询集群列表
1. 在 Cache Clusters 表格中查看集群列表
2. 在搜索框中输入集群 ID、引擎等
3. 点击行以查看详细信息

### 监控节点性能
在 Cache Nodes 表格中：
1. 查看 CPU/Engine CPU 使用率
2. 监控 Memory 使用量
3. 查看 Network In/Out 流量
4. 监控 Connections 数量

### 查看 Replication Group
在 Replication Groups 表格中：
- Group ID、状态
- Multi-AZ 设置
- Auto Failover 设置
- Cluster Mode 状态

## 使用技巧

:::tip 引擎选择指南
- **Valkey**: 兼容 Redis 的开源引擎，针对 AWS 优化
- **Redis**: 丰富的数据结构，支持 Pub/Sub
- **Memcached**: 简单的键值缓存，支持多线程
:::

:::info 加密建议
为了安全，请同时启用 At-Rest 加密和 Transit 加密。可以在详情面板的 Security 部分查看当前的加密设置。
:::

## AI 分析技巧

可以向 AI 助手提出如下问题：

- "哪些 ElastiCache 集群未启用加密？"
- "分析一下 Redis 集群的内存使用率"
- "查看 Cache Hit Rate 较低的集群"
- "比较不同 ElastiCache 节点类型的成本"

:::tip Data Gateway
AI 助手通过 Data Gateway（15 个工具）支持 ElastiCache 性能分析、缓存优化、成本分析等功能。
:::

## 相关页面

- [VPC](../network/vpc) - ElastiCache 所部署的 VPC 及 Security Group
- [CloudWatch](../monitoring/cloudwatch) - ElastiCache 相关告警
- [Cost Explorer](../monitoring/cost) - ElastiCache 成本分析
