---
sidebar_position: 1
title: 数据源
description: 连接可观测性提供商、验证访问，并通过只读查询查看证据
---

# 数据源

通过**集成 → Datasources** 注册可观测性端点，再打开实例的 **浏览 →** 页面。同一种提供商可注册多个实例。配置已保存、连接测试成功和工作负载健康是不同状态。

**权限与范围** 已登录用户可以查看实例列表、使用 Explore，并请求 AI 查询草稿。 管理员负责创建、编辑、删除、选择默认实例、管理凭证和执行连接测试。端点与设置详情仅向管理员显示。 注册配置是全局的。切换侧边栏账号不会切换数据源端点；Explore 按所选实例 ID 查询。 同类型的首个实例成为默认实例。默认标记是选择偏好，不是连接或健康检查结果。

## 支持的提供商

| 提供商 | Explore 查询 | 连接测试 |
|---|---|---|
| Prometheus | PromQL，例如 `up` | `/-/healthy` |
| Mimir | PromQL，例如 `up` | `/ready` |
| Loki | LogQL，例如 `{job="varlogs"} \|= "error"` | `/ready` |
| Tempo | TraceQL，例如 `{ duration > 500ms }` | `/ready` |
| ClickHouse | 只读 SQL；可从 `SELECT 1` 开始 | `/ping` |
| Jaeger | 服务名或 `service=frontend&limit=20` 等搜索参数 | `/api/services` |
| Dynatrace | Metrics API v2 `metricSelector`，例如 `builtin:host.cpu.usage:avg` | `/api/v2/metrics?pageSize=1` |
| Datadog | 指标查询，例如 `avg:system.cpu.user{*}` | `/api/v1/validate`，随后执行一分钟范围的 `/api/v1/query` |

请使用环境中实际存在的指标、标签、服务和表名。Jaeger Explore 返回精简的追踪搜索结果，不会将单独的 Trace ID 解释为直接追踪查询。Dynatrace 使用 Metrics API v2，而非 Grail DQL；其独立的 Problems 工具需要 `problems.read`，指标测试不会验证该权限。Datadog 数据源查询指标时间序列，不搜索日志或 APM 追踪。

## 连接、测试和保存

1. 选择**添加数据源**、提供商，输入名称和 API 基础 URL。表单提供类型对应的 URL 提示；请使用正确的 Datadog 站点或 Dynatrace 环境。
2. 输入认证信息。不要将凭证放入 URL；API 基础 URL 不得包含用户信息、查询参数或片段。
3. 无论连接器类型或认证方式，请填写后端要求的 **Org ID (X-Scope-OrgID)**。同一端点留空会保留租户；地址更改或不一致时需重新输入凭证和租户。若要移除租户，请在编辑中明确勾选默认未选中的 **清除已保存的 Org ID**（API: `creds: { org_id: '' }`）。勾选期间 Org ID 输入框被禁用，更改端点不会自动勾选此项。
4. 按需设置 Timeout（整数秒1–60，默认10）和 ClickHouse Database（最多128字符的标识符，不允许 `system`/`information_schema`）。
5. 点击**测试连接**并检查成功或失败状态。成功时显示往返延迟。Datadog 验证 API key 和 Application key 的指标查询权限；空查询结果也可能表示连接测试成功。
6. **保存**后，通过 **浏览 →** 执行一个小范围只读查询，确认目标数据集访问。例如，ClickHouse `/ping` 只验证可达性，不证明查询权限。

建议先测试，但保存本身不代表测试成功。编辑时不会显示已存储的秘密值。保持端点和认证方式不变，并将认证字段留空，可继续使用已存值。编辑测试仅在完整端点不变时复用该实例的凭证；更改主机、协议、端口或路径后必须重新输入。修改连接字段会清除先前测试结果。

**None** 无需认证，**Basic** 使用用户名和密码，**Bearer token** 使用令牌。Dynatrace 默认选择令牌认证，发送 `Authorization: Api-Token`，并需要 `metrics.read`。 **Custom header** 支持最多两组名称和值，禁止覆盖 Host、Content-Length、Authorization。Datadog 默认选择 **API key** / **Application key**，分别发送为 `DD-API-KEY` / `DD-APPLICATION-KEY`。 凭证存储在服务端 Secrets Manager，不会返回到表单。

### 正确理解状态

| 状态 | 含义及下一步 |
|---|---|
| 已保存 · 未验证 | 必要配置存在；请执行测试及代表性查询 |
| 仅有默认连接配置 · 需要保存实例配置 | 仅有旧的默认连接信息；请在编辑中确认端点、测试并保存实例配置 |
| 需要检查连接地址 | 端点缺失或无效；请管理员检查 HTTP(S) API 基础 URL |
| 需要配置身份验证 | 缺少必要的已存凭证；请管理员补充 |
| 连接成功（编辑中的测试） | 此提供商的测试通过；不代表所有 API 权限、数据集或工作负载均已验证 |
| 状态不可用 | 无法读取配置；请重试或检查管理员访问权限，不要当作空列表 |
| 已禁用 | 该行已禁用，不提供 AI 诊断快捷入口 |

## Explore 与查询限制

选择实例并审核原生查询，然后点击**运行**。单行查询框可按 Enter 执行，多行 SQL 可按 Ctrl+Enter。查询示例标签会立即执行；自然语言示例标签只填充请求文本。若提供诊断信号标签，点击后也会执行所选查询。 Prometheus/Mimir/Loki 更改支持的时间范围时会重新执行当前查询。

- Timeout 的应用因类型而异：ClickHouse 执行最多55秒，Prometheus/Mimir Explore 最多10秒；其他类型只保存设置，目前不应用。连接测试使用独立的时间限制。
- 原生查询最多8,000字符，ClickHouse Explore 最多请求500行。ClickHouse 拒绝变更语句、SYSTEM/system 表和表函数。请从 `SELECT 1` 或已发现且允许访问的用户表开始。

## AI 查询草稿、聊天与诊断

输入自然语言请求，点击**使用 AI 生成**或在该输入框按 Enter。查询会填入编辑器，也可能显示词汇或模式警告。**生成过程不会执行生成的查询。** 请审核后单独点击**运行**。自然语言输入限制为 4,000 字符。 模式词汇可能缺失、过期或不完整；运行前请核对名称、范围和警告。

**用 AI 诊断**仅显示在 Prometheus、ClickHouse、Loki、Mimir、Tempo 已启用且已配置的默认实例上。它会在 `/assistant` 预填分区提示：Prometheus/ClickHouse 使用 `/observability`，Loki/Mimir/Tempo 使用 `/monitoring`。审核后手动发送，开始新对话。原生聊天使用默认实例；其他实例的证据请在 Explore 中查看。

**Datadog、Dynatrace 支持 Explore 和 AI 查询草稿，但默认未连接原生聊天网关目标或自动诊断报告采集。** Jaeger 同样支持 Explore 和草稿，但没有原生聊天目标或自动报告采集器。注册数据源不会添加这些路径。

工作器的外部证据采集当前仅覆盖 Prometheus、Mimir、Loki、Tempo、ClickHouse，并要求启用 `datasource_diagnosis_enabled` 及其 AgentCore、integrations、workers 依赖。仅注册不会启用采集。报告应明确保留不可用或不完整的证据状态。

受支持的厂商 hosted MCP 预设是 **Connectors** 中的独立路径，使用独立凭证、部署开关和工具允许列表。保存 Datadog 或 Dynatrace 数据源不会激活 hosted MCP。v2 没有 `datasource` 聊天路由，也没有实时 Steampipe 聊天查询路径。

## 排查与安全使用

- 认证失败或 Timeout 时，请检查 API 站点或环境、读取权限和连接器到端点的可达性，再缩小查询和时间范围。指标测试不会验证 Problems API 权限。
- 支持 HTTP(S) 私有数据源，但元数据、环回、链路本地及其他被阻止的特殊地址仍不可访问。重定向和不安全 URL 格式会被拒绝。v2 没有 Allowed Networks 例外编辑器。
- 查询、保存、删除或修改默认实例失败时，请检查错误并重试。截断、部分、过期、未评估或空的结果不能证明健康。请核对来源和时间范围，并缩小请求。

相关指南：[自定义代理与技能](../operations/custom-agents) · [AI 助手](../overview/assistant) · [AI 诊断报告](../operations/ai-diagnosis)
