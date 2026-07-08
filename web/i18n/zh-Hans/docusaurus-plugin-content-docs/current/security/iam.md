---
sidebar_position: 1
---

import Screenshot from '@site/src/components/Screenshot';

# IAM

在 IAM（Identity and Access Management）页面中，您可以一目了然地查看和管理 AWS 账户的用户、角色和策略。

<Screenshot src="/screenshots/security/iam.png" alt="IAM" />

## 主要功能

### 摘要统计

在页面顶部可以查看 IAM 资源的当前状态：

- **Users**：IAM 用户总数
- **Roles**：IAM 角色总数
- **Custom Policies**：客户托管策略数量
- **MFA Not Enabled**：未启用 MFA 的用户数量

:::tip MFA 安全建议
如果存在未启用 MFA 的用户，页面顶部会显示警告横幅。建议为所有 IAM 用户启用 MFA。
:::

### MFA 状态图表

通过饼图可视化 MFA 启用状况：

- **绿色**：已启用 MFA 的用户
- **红色**：未启用 MFA 的用户

## IAM 用户列表

以表格形式显示所有 IAM 用户：

| 列 | 说明 |
|------|------|
| Username | 用户名 |
| User ID | AWS 分配的唯一 ID |
| Created | 用户创建日期 |
| Password Last Used | 最近一次使用密码的日期（控制台登录） |

### 用户详细信息

在表格中点击用户后，可以在滑出面板中查看详细信息：

- 用户名、ID、ARN
- 路径（Path）
- 创建日期及最近一次使用密码的日期
- 标签信息

## IAM 角色列表

以表格形式显示所有 IAM 角色：

| 列 | 说明 |
|------|------|
| Role Name | 角色名称 |
| Role ID | AWS 分配的唯一 ID |
| Path | 角色路径 |
| Description | 角色描述 |
| Created | 角色创建日期 |
| Max Session | 最大会话持续时间 |

### 角色详细信息

在表格中点击角色后，可以查看详细信息：

**基本信息**
- 角色名称、ID、ARN、路径
- 描述及创建日期
- 最大会话持续时间
- 权限边界（Permissions Boundary）ARN

**最近使用信息**
- 最近使用时间
- 最近使用的区域

**实例配置文件**
- 关联的实例配置文件 ARN 列表

**信任策略**
- 以 JSON 形式显示 `AssumeRolePolicyDocument`
- 确认哪些实体（服务、账户、用户）可以代入该角色

:::info 信任策略分析
信任策略定义了可以代入（Assume）该角色的主体。请在 `Principal` 字段中确认允许的服务、账户 ID 和用户 ARN。
:::

## 数据刷新

点击右上角的刷新按钮可以使缓存失效并查询最新数据。

:::tip 缓存策略
IAM 数据会缓存 5 分钟。如需立即生效，请使用刷新按钮。
:::
