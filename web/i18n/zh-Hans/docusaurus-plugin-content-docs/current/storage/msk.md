---
sidebar_position: 7
---

import Screenshot from '@site/src/components/Screenshot';

# MSK

监控 Amazon MSK(Managed Streaming for Apache Kafka)集群并查看 Broker 性能。

<Screenshot src="/screenshots/storage/msk.png" alt="MSK" />

## 主要功能

### 统计卡片
- **Total Clusters**: 集群总数(包含活跃集群数)
- **Active**: 处于活跃状态的集群数
- **Total Brokers**: Broker 节点总数
- **Enhanced Monitoring**: 已启用增强监控的集群数
- **In-Transit Encrypted**: 已启用传输中加密的集群数
- **Avg Brokers/Cluster**: 每个集群的平均 Broker 数

### 可视化图表
- **Cluster State**: 按 ACTIVE、CREATING 等状态的分布
- **Kafka Version**: 按 Kafka 版本的分布

### Broker Nodes 指标表格
从 CloudWatch 收集的各 Broker 实时指标:
- **Cluster**: 集群名称
- **Type**: BROKER 或 CONTROLLER
- **ID**: Broker ID
- **Instance**: 实例类型
- **VPC IP**: Broker 的 VPC IP 地址
- **ENI**: 关联的 ENI ID
- **CPU**: CPU 使用率(User + System)
- **Memory**: 内存使用率
- **Network In/Out**: 网络流量(KB/s)
- **Endpoint**: Broker 端点

### 详情面板
点击集群后可查看的信息:
- 集群名称、状态、类型
- Kafka 版本、Broker 数量
- Enhanced Monitoring 设置
- 存储模式
- Broker 配置(实例类型、EBS 大小、AZ 分布)
- Security Group、Subnet 信息
- 加密设置(In-Transit、At-Rest、KMS)
- 身份验证设置(IAM、SCRAM、TLS)
- Bootstrap Brokers(Plaintext、TLS)
- Broker 节点详细信息
- Open Monitoring(JMX/Node Exporter)
- 日志设置

## 使用方法

### 查询集群列表
1. 在搜索框中输入集群名称、Kafka 版本等
2. 在表格中查看状态、实例类型、Broker 数量
3. 点击行查看详细信息

### 监控 Broker 性能
在 Broker Nodes 表格中:
1. 查看 **CPU** 使用率(超过 80% 需注意)
2. 监控 **Memory** 使用率(超过 85% 为警告)
3. 查看 **Network In/Out** 流量
4. 查看各集群的 Broker 分布

### 查看 Bootstrap Brokers
在详情面板中查看 Bootstrap Brokers 端点:
- **Plaintext**: 用于未加密连接
- **TLS**: 用于 TLS 加密连接

## 使用技巧

:::tip Broker 数量规划
请综合考虑分区数和复制因子来规划合适的 Broker 数量。通常建议使用 3 个以上的 Broker,并为实现高可用性将其分布部署在多个 AZ 中。
:::

:::info KRaft 模式
Kafka 3.x 及以上版本可以使用 KRaft 模式替代 ZooKeeper。如果 Broker Nodes 表格中显示 CONTROLLER 类型的节点,则表示处于 KRaft 模式。
:::

## AI 分析技巧

可以向 AI 助手提出如下问题:

- "MSK Broker 中 CPU 使用率较高的是哪些?"
- "帮我确认未启用传输中加密的集群"
- "分析 MSK 集群的网络流量趋势"
- "哪些集群需要升级 Kafka 版本?"

:::tip Data Gateway
AI 助手通过 Data Gateway(15 个工具)支持 MSK 集群分析、Broker 性能调优、Topic 管理等功能。
:::

## 相关页面

- [VPC](../network/vpc) - MSK 所部署的 VPC 及 Security Group
- [CloudWatch](../monitoring/cloudwatch) - MSK 相关告警
- [Cost Explorer](../monitoring/cost) - MSK 成本分析
