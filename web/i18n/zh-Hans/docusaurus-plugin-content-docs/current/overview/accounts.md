---
sidebar_position: 4
title: 账户管理
description: 面向多账户 AWS 监控的账户添加、删除与测试管理页面
---

import Screenshot from '@site/src/components/Screenshot';
import MultiAccountSetupFlow from '@site/src/components/diagrams/MultiAccountSetupFlow';

# 账户管理

账户管理页面是面向 AWSops 多账户监控的管理员专用页面。您可以在一个地方完成 Host 账户自动检测、Target 账户添加/删除、连接测试以及功能检测。

<Screenshot src="/screenshots/overview/accounts.png" alt="账户管理" />

## 配置流程

下面的示意图展示了 Host 账户与 Target 账户的注册过程，以及 Admin 访问控制流程。将鼠标悬停在各节点上可查看详细说明。

<MultiAccountSetupFlow />

## 主要功能

### Host 账户配置

在尚未注册任何账户的状态下访问该页面时，会显示 Host 账户注册横幅。

| 项目 | 说明 |
|------|------|
| **自动检测** | 使用 EC2 实例凭证调用 STS GetCallerIdentity |
| **功能检测** | 探测 Cost Explorer、EKS、K8s API，自动配置可用功能 |
| **Alias 输入** | 指定 Host 账户的显示名称（默认值："Host"） |
| **注册到 config.json** | 以 `isHost: true` 注册到 `data/config.json` 的 `accounts[]` 数组中 |

### 已注册账户管理

所有已注册的账户以表格形式显示。

| 列 | 说明 |
|------|------|
| **Alias** | 账户显示名称 |
| **Account ID** | 12 位 AWS 账户 ID |
| **Region** | 默认区域 |
| **Type** | Host 或 Target |
| **Features** | Cost、EKS、K8s 的启用状态（徽章形式） |
| **Actions** | 连接测试、删除（Host 账户不可删除） |

### 添加新账户

要添加 Target 账户，请输入以下信息。

| 字段 | 格式 | 说明 |
|------|------|------|
| **Account ID** | 12 位数字 | AWS 账户 ID |
| **Alias** | 英文/数字/空格/连字符/下划线 | 在仪表板上显示的名称 |
| **Region** | 选择 | 从 10 个主要区域中选择 |
| **Role Name** | 字符串 | 跨账户 IAM 角色名称（默认：`AWSopsReadOnlyRole`） |

添加之前，请务必使用 **Test Connection** 验证 AssumeRole 连接。

### Target 账户 CloudFormation 部署

在添加新账户之前，需要先在该账户中创建跨账户 IAM 角色。

```bash
aws cloudformation deploy \
  --template-file infra-cdk/cfn-target-account-role.yaml \
  --stack-name awsops-target-role \
  --parameter-overrides HostAccountId=<HOST_ACCOUNT_ID> \
  --capabilities CAPABILITY_NAMED_IAM
```

该命令将创建以下内容：
- **AWSopsReadOnlyRole**：可由 Host 账户执行 AssumeRole 的只读角色
- **Trust Policy**：将 Host 账户 ID 指定为 Principal
- **权限**：ReadOnlyAccess + 所需的附加策略

## Admin 访问控制

只有管理员才能访问账户管理页面。

| 项目 | 说明 |
|------|------|
| **配置位置** | `data/config.json` 的 `adminEmails` 数组 |
| **空数组** | 为 `[]` 时，允许所有已认证用户访问 |
| **验证流程** | 从 JWT 中提取邮箱 → 与 `adminEmails` 数组匹配 → 允许/拒绝 |
| **速率限制** | 每个用户每分钟限制 5 次请求 |
| **API 保护** | add-account、remove-account、init-host 均应用相同的 admin 检查 |

```json
{
  "adminEmails": ["admin@example.com", "ops@example.com"]
}
```

:::warning 未配置 Admin 时
如果 `adminEmails` 为空数组，任何已认证用户都可以添加/删除账户。在生产环境中请务必指定管理员邮箱。
:::

## 使用方法

1. **注册 Host 账户**：在首次访问时显示的横幅中输入 Alias，然后点击 "Detect & Register Host"
2. **准备 Target 账户**：在 Target 账户中部署 CloudFormation 堆栈
3. **连接测试**：输入 Account ID，使用 "Test Connection" 验证 AssumeRole
4. **添加账户**：输入 Alias、Region，然后点击 "Add Account"
5. **确认**：在已注册账户表格中确认 Features 徽章
6. **配置 Steampipe**：为新账户配置 Steampipe connection（自动添加到 Aggregator）

## 使用技巧

:::tip 功能徽章
账户注册后，会自动检测 Cost、EKS、K8s 功能。未显示徽章的功能表示该账户中相应服务未启用或权限不足。
:::

:::info Steampipe Aggregator 模式
`aws` connection 会统一查询所有已注册账户的数据。查询单个账户时使用 `aws_{accountId}` connection，可在 AccountSelector 下拉菜单中选择。
:::

:::tip 删除账户时
删除 Target 账户后，该账户的 CloudFormation 堆栈不会被自动删除。如有需要，请在 Target 账户中单独删除堆栈。
:::

## AI 分析技巧

向 AI 助手提出以下问题，可以快速查看已注册账户的相关信息：

- "显示已注册的账户列表"
- "哪些账户启用了 Cost Explorer？"
- "哪些账户有 EKS 集群？"
- "告诉我 Staging 账户的资源现状"
- "比较所有账户的 EC2 实例数量"

## 相关页面

- [仪表板](../overview/dashboard) - 多账户统一仪表板
- [AI 助手](../overview/ai-assistant) - 基于 AI 的账户分析
- [AgentCore](../overview/agentcore) - 跨账户工具执行
