---
sidebar_position: 1
title: VPC / Network
description: VPC、Subnet、Security Group、Transit Gateway、ELB、NAT Gateway、Internet Gateway 监控
---

import Screenshot from '@site/src/components/Screenshot';

# VPC / Network

这是一个可以一目了然地掌握 AWS 网络基础设施的综合监控页面。

<Screenshot src="/screenshots/network/vpc.png" alt="VPC" />

## 主要功能

### 基于选项卡的资源分类

通过 8 个选项卡系统地管理网络资源:

| 选项卡 | 资源 | 主要信息 |
|---|--------|----------|
| **VPCs** | Virtual Private Cloud | CIDR、租赁模式、DNS 设置 |
| **Subnets** | 子网 | AZ、CIDR、公有/私有 |
| **Security Groups** | 安全组 | 入站/出站规则 |
| **Route Tables** | 路由表 | 路由、子网关联 |
| **Transit Gateway** | TGW | VPC 连接、路由表 |
| **ELB** | 负载均衡器 | ALB/NLB、目标组、监听器 |
| **NAT** | NAT Gateway | EIP、连接状态 |
| **IGW** | Internet Gateway | VPC 连接 |

### 资源地图 (Resource Map)

以可视化方式展示 VPC 内所有资源之间的关系:

- **5 列布局**: External (IGW/TGW) → VPCs → Subnets → Compute → NAT
- **交互操作**: 点击可高亮显示相关资源
- **搜索**: 可通过名称/ID/CIDR 搜索 EC2、Subnet、VPC

### 详情面板

点击资源行时,可在滑出面板中查看详细信息:

- Transit Gateway: 路由表、路由、已连接的 VPC
- Security Group: 入站/出站规则完整列表
- ELB: 目标组、监听器、健康检查设置

## 使用方法

### 查看资源列表

1. 在顶部选项卡中选择要查看的资源类型
2. 在表格中查看资源
3. 点击行以打开详细信息面板

### 使用资源地图

1. 在 VPCs 选项卡中点击 **Resource Map** 按钮
2. 在 5 列视图中查看基础设施结构
3. 点击资源以高亮显示关联关系
4. 通过搜索框查找特定资源

### Transit Gateway 分析

1. 选择 **Transit Gateway** 选项卡
2. 点击 TGW 行
3. 在详情面板中查看:
   - Route Tables: TGW 路由表列表
   - Routes: 各表的路由 (VPC CIDR → Attachment)
   - Attachments: 已连接的 VPC/VPN 列表

## 使用技巧

:::tip 网络故障排查
在 AI 助手中提出网络相关问题时,**Network Gateway** 会自动激活。它利用 17 个专业工具:

- **Reachability Analyzer**: 分析两个端点之间的连接路径
- **VPC Flow Logs**: 分析网络流量模式
- **Transit Gateway 路由**: 诊断多 VPC 路由问题
- **Security Group 规则验证**: 分析入站/出站规则

示例问题: "EC2 i-xxx 无法连接到 RDS" → 自动执行 Reachability Analyzer
:::

:::info 查看 Security Group 规则
在 Security Groups 选项卡中点击某一行,即可一目了然地查看入站/出站规则。对 0.0.0.0/0 开放的端口会以橙色警告标示。
:::

## 相关页面

- [Topology](../network/topology) - 基于 React Flow 的基础设施可视化
- [WAF](../network/waf) - Web Application Firewall 规则管理
- [CloudFront](../network/cloudfront) - CDN 分发管理
- [Security](../security) - Open Security Group 检测
