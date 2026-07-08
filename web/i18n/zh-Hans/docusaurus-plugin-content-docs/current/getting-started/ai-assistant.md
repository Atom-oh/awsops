---
sidebar_position: 3
title: AI 助手快速入门
description: AWSops AI 助手基本使用方法
---

# AI 助手快速入门

AWSops AI 助手基于 Amazon Bedrock AgentCore，提供以自然语言询问 AWS 基础设施并请求分析的功能。

## 开始使用

### 1. 访问 AI Assistant 页面

在侧边栏中点击 **AI Assistant**。

### 2. 输入问题

在屏幕下方的输入框中输入问题，然后按 **Enter** 或点击发送按钮。

### 3. 查看响应

AI 会分析问题并路由到合适的 Gateway，利用工具生成答案。

## 示例问题

### 资源现状查询

```
查看 EC2 实例状态
```

```
查一下有多少个 S3 存储桶
```

```
显示 Lambda 函数列表
```

### 网络分析

```
分析 VPC 网络配置
```

```
检查安全组中是否存在 0.0.0.0/0 入站规则
```

### 安全检查

```
检查是否存在安全问题
```

```
检查是否有未启用 MFA 的 IAM 用户
```

### 成本分析

```
显示本月的成本状况
```

```
按服务比较成本
```

### 容器现状

```
查看 EKS 集群状态
```

```
确认 ECS 服务状态
```

## 10 级路由

AI 助手会分析问题，并自动将其分类到 10 个专业路由中最合适的一个。

| 优先级 | 路由 | 用途 |
|---------|--------|------|
| 1 | code | Python 代码执行、计算、可视化 |
| 2 | network | VPC、TGW、VPN、Flow Logs 分析 |
| 3 | container | EKS、ECS、Istio 故障排查 |
| 4 | iac | CDK、CloudFormation、Terraform |
| 5 | data | DynamoDB、RDS、ElastiCache、MSK |
| 6 | security | IAM、策略模拟、安全摘要 |
| 7 | monitoring | CloudWatch、CloudTrail |
| 8 | cost | 成本分析、预测、预算 |
| 9 | aws-data | 资源列表/现状（Steampipe SQL） |
| 10 | general | 一般 AWS 问题、文档搜索 |

:::tip 查看路由
通过响应下方显示的路由信息，可以确认使用了哪个 Gateway。
例如：`Network Gateway (17 tools)`、`Bedrock + Steampipe SQL`
:::

## 理解响应

### 响应结构

```
┌────────────────────────────────────────────────────────┐
│  [AI 图标]                                             │
│                                                        │
│  响应内容 (Markdown 格式)                              │
│  - 支持表格、列表、代码块                              │
│                                                        │
├────────────────────────────────────────────────────────┤
│  Network Gateway (17 tools)  │  Claude sonnet-4.6  │ 3.2s │
├────────────────────────────────────────────────────────┤
│  Tools: list_vpcs, get_vpc_network_details, ...        │
│  Queried: aws_vpc, aws_vpc_subnet                      │
└────────────────────────────────────────────────────────┘
```

### 显示信息

- **路由路径**：由哪个 Gateway 处理
- **模型**：使用的 Claude 模型（Sonnet/Opus）
- **响应时间**：处理所耗费的时间
- **使用的工具**：调用的 MCP 工具列表
- **查询的资源**：在 Steampipe 中查询的表

### 实时流式传输

响应会实时流式传输并逐步显示在屏幕上。系统会根据路由自动选择最佳的流式传输模式：

- **单一 Gateway 响应**：以打字效果自然呈现
- **多路由合成**：通过 Bedrock Converse API 实时流式传输合成结果
- **数据查询（aws-data）**：Bedrock 原生 Token 流式传输

## 模型选择

可以在屏幕右上方的下拉菜单中选择模型：

- **Claude Sonnet 4.6**：响应快速，适合一般性问题（默认值）
- **Claude Opus 4.6**：适合复杂分析和深度推理

## 关联问题

响应后，相关的后续问题会以按钮形式显示。点击后该问题会自动填入输入框。

示例：
```
[显示 IAM 用户列表和 Access Key 状态]
[检查是否有未启用 MFA 的用户]
[检查安全组中是否存在 0.0.0.0/0 入站规则]
```

## 对话历史

### 会话内历史
当前会话的对话内容会保留在屏幕上。可以参考之前的对话进行后续提问。

### 已保存的历史
展开屏幕下方的**对话历史**面板，可以查看之前会话的对话记录并再次提问。

## 下一步

- [AI 助手详情](../overview/ai-assistant) - 10 级路由详情及高级功能
- [AgentCore 详情](../overview/agentcore) - AgentCore 架构及工具列表
