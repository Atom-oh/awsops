---
sidebar_position: 1
---

import Screenshot from '@site/src/components/Screenshot';

# EBS

管理和监控 EBS(Elastic Block Store)卷及快照。

<Screenshot src="/screenshots/storage/ebs.png" alt="EBS" />

## 主要功能

### 统计卡片
- **Total Volumes**: 卷总数(区分 in-use/available)
- **Total Size**: 总存储容量(使用中/闲置容量)
- **Encrypted**: 已加密卷的比例
- **Unencrypted**: 未加密卷数量(安全警告)
- **Snapshots**: 快照数量及加密状态
- **Idle Volumes**: 闲置卷数量(成本节省对象)

### 可视化图表
- **Volume Type**: gp3、gp2、io1、io2 等按类型分布
- **State**: in-use、available 等按状态分布
- **Encryption**: 加密与否的分布

### 卷/快照选项卡
将卷和快照分为独立选项卡进行查看:
- **Volumes 选项卡**: 卷列表、类型、大小、IOPS、关联的 EC2
- **Snapshots 选项卡**: 快照列表、创建日期、加密状态

### 详情面板
点击卷后可在右侧面板中查看:
- 卷 ID、名称、类型、大小
- IOPS、Throughput、AZ
- Multi-Attach 设置
- 加密状态及 KMS 密钥
- 关联的 EC2 实例信息
- 该卷的快照列表

## 使用方法

### 查看卷
1. 在 Volumes 选项卡中查看全部卷列表
2. 在搜索框中输入卷 ID、名称、类型等进行筛选
3. 点击表格行查看详细信息

### 查看快照
1. 点击 Snapshots 选项卡
2. 按快照 ID、卷 ID、名称进行搜索
3. 查看创建日期、加密状态

### 确认 EC2 关联
在卷详情面板的 "Attached Resources" 部分中查看:
- 关联的 EC2 实例 ID
- 设备路径(例如: /dev/xvda)
- 实例名称、类型、状态

## 使用技巧

:::tip 闲置卷管理
处于 "available" 状态的卷未连接到 EC2,只会产生费用。请在 Idle Volumes 卡片中确认闲置卷,并删除不必要的卷。
:::

:::info 建议启用加密
为满足安全合规要求,建议对所有 EBS 卷进行加密。可以在 Unencrypted 卡片中确认未加密的卷,然后通过创建加密快照并恢复的方式应用加密。
:::

## AI 分析技巧

可以向 AI 助手提出以下问题:

- "显示未加密的 EBS 卷列表"
- "闲置 EBS 卷的总容量和预估费用是多少?"
- "从 gp2 迁移到 gp3 能节省多少成本?"
- "帮我确认连接到特定 EC2 的卷的 IOPS 设置"

:::tip Data Gateway
AI 助手通过 Data Gateway(15 个工具)支持 EBS 卷分析、快照管理、成本优化等功能。
:::

## 相关页面

- [EC2](../compute/ec2) - 连接了 EBS 卷的实例
- [Cost Explorer](../monitoring/cost) - EBS 成本分析
- [Security](../security) - 未加密卷的安全检查
