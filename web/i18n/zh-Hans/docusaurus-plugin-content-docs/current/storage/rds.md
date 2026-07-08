---
sidebar_position: 3
---

import Screenshot from '@site/src/components/Screenshot';

# RDS

监控 RDS(Relational Database Service) 实例并查看性能指标。

<Screenshot src="/screenshots/storage/rds.png" alt="RDS" />

## 主要功能

### 统计卡片
- **Total Instances**: 全部 RDS 实例数量
- **Storage (GB)**: 已分配的存储总容量
- **Multi-AZ**: 以 Multi-AZ 方式部署的实例数量
- **Engines**: 正在使用的数据库引擎种类数量

### 可视化图表
- **Engine Distribution**: MySQL、PostgreSQL、Aurora 等按引擎划分的分布
- **Storage by Instance**: 各实例的存储使用量

### 实例指标表格
以表格形式展示从 CloudWatch 采集的实时指标：
- **CPU**: CPU 使用率（进度条 + 数值）
- **Free Memory**: 可用内存
- **Connections**: 当前连接数
- **Read/Write IOPS**: 读/写 IOPS
- **Network In/Out**: 网络流量
- **Free Storage**: 可用存储

### Security Group 链路
在详情面板中查看与 RDS 关联的 Security Group 及入站规则：
- Security Group ID、名称
- 协议、端口范围
- 源 IP 或被引用的 Security Group

### 详情面板
点击实例后可查看的信息：
- 实例标识符、引擎、版本、实例类
- 存储配置（类型、容量、加密）
- 网络配置（VPC、子网、端点）
- 备份配置（保留期、备份窗口）
- 安全功能（IAM 认证、Performance Insights 等）
- CloudWatch 指标图表

## 使用方法

### 查询实例列表
1. 在搜索框中输入实例标识符、引擎等
2. 在表格中查看状态、引擎、实例类
3. 点击行查看详细信息

### 性能监控
在 Instance Metrics 表格中：
1. 查看 CPU 使用率（超过 80% 需注意）
2. 查看 Free Memory 与 Free Storage
3. 监控 Connection 数量
4. 查看 IOPS 及网络流量

### 查看 Security Group
在详情面板的 "Security Groups" 部分：
1. 查看已关联的 Security Group 列表
2. 查看每个 SG 的入站规则
3. 检查是否存在意外的大范围放行

## 使用技巧

:::tip 建议使用 Multi-AZ
生产工作负载建议采用 Multi-AZ 部署。通过自动故障转移可确保高可用性。请在 Multi-AZ 卡片中查看当前部署状态。
:::

:::info 存储自动扩展
当 Free Storage 变低时，请检查存储自动扩展设置。可在指标表格中监控每个实例的可用存储。
:::

## AI 分析技巧

可以向 AI 助手提出如下问题：

- "RDS 实例中哪些 CPU 使用率较高？"
- "帮我检查未启用 Multi-AZ 的生产数据库"
- "帮我分析 RDS 连接数趋势"
- "分析可访问特定 RDS 的 Security Group"

:::tip Data Gateway
AI 助手可通过 Data Gateway（15 个工具）支持 RDS 性能分析、查询优化建议、备份状态检查等。还可与 Monitoring Gateway 联动，分析 CloudWatch 告警设置。
:::

## 相关页面

- [VPC](../network/vpc) - RDS 所部署的 VPC 及 Security Group
- [CloudWatch](../monitoring/cloudwatch) - RDS 相关告警
- [Cost Explorer](../monitoring/cost) - RDS 成本分析
