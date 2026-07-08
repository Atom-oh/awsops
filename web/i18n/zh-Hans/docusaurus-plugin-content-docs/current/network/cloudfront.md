---
sidebar_position: 2
title: CloudFront
description: 监控 CloudFront 分发状态、域名、源站和缓存策略
---

import Screenshot from '@site/src/components/Screenshot';

# CloudFront

用于监控和管理 Amazon CloudFront CDN 分发的页面。

<Screenshot src="/screenshots/network/cloudfront.png" alt="CloudFront" />

## 主要功能

### 汇总统计

通过顶部卡片查看整体 CloudFront 分发状况：

| 指标 | 说明 |
|------|------|
| **Distributions** | 分发总数 |
| **Enabled** | 已启用的分发数 |
| **Disabled** | 已禁用的分发数 |
| **HTTP Allowed** | 允许 HTTP 的分发（安全警告） |

:::info 允许 HTTP 警告
当 HTTP Allowed 卡片显示为橙色时，建议配置为仅使用 HTTPS。同时会显示 "Consider HTTPS only" 消息。
:::

### 分发列表

在表格中查看所有 CloudFront 分发：

- **Distribution ID**: 唯一标识符
- **Name**: 分发名称（基于标签）
- **Domain**: CloudFront 域名 (xxx.cloudfront.net)
- **Status**: Deployed、InProgress 等
- **Enabled**: 是否启用
- **Protocol**: Viewer Protocol Policy

### 详情面板

点击分发所在行可查看详细信息：

**Distribution 部分**
- ID、ARN、Domain
- HTTP Version、IPv6 支持
- Price Class（PriceClass_All、PriceClass_100 等）
- 是否关联 WAF ACL

**Origins 部分**
- 每个 Origin 的 ID 和 Domain
- 区分 S3、ALB、Custom Origin

**Aliases (CNAMEs) 部分**
- 已关联的备用域名列表

**Tags 部分**
- 资源标签键值对

## 使用方法

### 查看分发状态

1. 进入 CloudFront 页面
2. 通过顶部汇总卡片了解整体状况
3. 在表格中查找特定分发
4. 通过 Status 列确认分发状态

### 查询分发详细信息

1. 在表格中点击分发所在行
2. 右侧滑出面板打开
3. 按部分查看详细信息：
   - Distribution: 基本配置
   - Origins: 源站服务器配置
   - Aliases: CNAME 配置
   - Tags: 资源标签

### 检查安全配置

1. 查看 HTTP Allowed 卡片（为 0 表示安全）
2. 在分发详情中确认 Protocol
3. 确认是否关联 WAF ACL（增强安全性）

## 使用技巧

:::tip 建议配置 HTTPS
所有 CloudFront 分发都建议使用 **redirect-to-https** 或 **https-only** 的 Viewer Protocol Policy。当 HTTP Allowed 变为 0 时，卡片会变为绿色。
:::

:::tip 关联 WAF
生产环境的分发应关联 WAF Web ACL，以拦截 Web 攻击（SQL Injection、XSS 等）。可以在详情面板的 WAF ACL 字段中确认关联状态。
:::

:::info Price Class 优化
不同的 Price Class 对应不同的费用和性能：
- **PriceClass_All**: 全球所有边缘节点（性能最佳，费用最高）
- **PriceClass_200**: 大多数区域（均衡）
- **PriceClass_100**: 仅北美/欧洲（费用最低）
:::

## 相关页面

- [WAF](../network/waf) - 管理关联到 CloudFront 的 WAF 规则
- [VPC](../network/vpc) - 查看源站服务器所在的 VPC
- [Cost](../monitoring/cost) - CloudFront 成本分析
