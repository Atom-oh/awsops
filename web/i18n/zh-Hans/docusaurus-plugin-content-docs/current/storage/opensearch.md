---
sidebar_position: 6
---

import Screenshot from '@site/src/components/Screenshot';

# OpenSearch

监控 Amazon OpenSearch Service 域并查看集群状态。

<Screenshot src="/screenshots/storage/opensearch.png" alt="OpenSearch" />

## 主要功能

### 统计卡片
- **Total Domains**: 域总数（包含活跃域数量）
- **Processing**: 正在进行配置更新的域数量
- **Node-to-Node Enc**: 已启用节点间加密的域数量
- **At-Rest Enc**: 已启用静态数据加密的域数量
- **VPC Domains**: 部署在 VPC 内的域数量
- **Public Domains**: 允许公开访问的域数量

### 可视化图表
- **Engine Version**: 按 OpenSearch/Elasticsearch 版本的分布
- **Encryption Status**: 加密配置状态分布

### Domain Metrics 表格
从 CloudWatch 采集的实时指标：
- **Domain**: 域名称
- **Engine**: 引擎版本
- **Cluster Status**: GREEN/YELLOW/RED 状态
- **CPU**: CPU 使用率
- **JVM Memory**: JVM 内存压力
- **Nodes**: 节点数量
- **Documents**: 可搜索的文档数量
- **Free Storage**: 可用存储空间
- **Search Rate/Latency**: 搜索请求数及延迟
- **Index Rate/Latency**: 索引请求数及延迟

### 详情面板
点击域后可查看的信息：
- 域名称、ID、引擎版本
- 状态、IP 类型、端点
- 集群配置（实例类型、节点数、Master 设置）
- EBS 存储配置
- 加密配置（Node-to-Node、At-Rest、KMS 密钥）
- Advanced Security 设置
- VPC/网络配置
- 服务软件版本
- 日志发布配置

## 使用方法

### 查询域列表
1. 在搜索框中输入域名称、引擎版本
2. 在表格中查看状态、实例类型、节点数量
3. 点击行查看详细信息

### 监控集群状态
在 Domain Metrics 表格中：
1. 查看 **Cluster Status**（GREEN 为正常）
2. 监控 CPU 及 JVM Memory 压力
3. 查看 Search/Index Latency
4. 监控 Free Storage

### 检查安全配置
1. 在加密卡片中掌握整体加密状态
2. 确认 VPC/Public 域的区分
3. 在详情面板中查看 Fine-Grained Access Control

## 使用技巧

:::tip Cluster Status 管理
- **GREEN**: 所有分片均已正常分配
- **YELLOW**: 部分副本分片未分配（功能正常）
- **RED**: 部分主分片未分配（可能导致数据丢失）

RED 状态需要立即处理。
:::

:::info 建议部署在 VPC 内
出于安全考虑，建议将 OpenSearch 域部署在 VPC 内。如果 Public Domains 卡片显示为红色，请考虑迁移到 VPC。
:::

## AI 分析技巧

可以向 AI 助手提出如下问题：

- "OpenSearch 集群状态为 YELLOW/RED 的域有哪些？"
- "帮我检查未启用节点间加密的域"
- "分析 OpenSearch 搜索延迟较高的域"
- "告诉我 OpenSearch 索引性能优化方法"

:::tip Data Gateway
AI 助手通过 Data Gateway（15 个工具）支持 OpenSearch 集群分析、索引优化、搜索性能调优等功能。
:::

## 相关页面

- [VPC](../network/vpc) - OpenSearch 部署所在的 VPC 及 Security Group
- [CloudWatch](../monitoring/cloudwatch) - OpenSearch 相关告警
- [Cost Explorer](../monitoring/cost) - OpenSearch 成本分析
