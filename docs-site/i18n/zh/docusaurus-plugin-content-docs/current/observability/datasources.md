---
sidebar_position: 1
title: 数据源
description: 连接可观测性提供商、验证访问，并通过只读查询查看证据
---

# 数据源

通过**集成 → Datasources** 注册可观测性端点，再打开实例的 **浏览 →** 页面。同一种提供商可注册多个实例。配置已保存、连接测试成功和工作负载健康是不同状态。

## 权限与范围

- 已登录用户可以查看实例列表、使用 Explore，并请求 AI 查询草稿。
- 管理员负责创建、编辑、删除、选择默认实例、管理凭证和执行连接测试。端点与设置详情仅向管理员显示。
- 注册配置是全局的。切换侧边栏账号不会切换数据源端点；Explore 按所选实例 ID 查询。
- 同类型的首个实例成为默认实例。默认标记是选择偏好，不是连接或健康检查结果。

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
3. 对 Loki、Tempo、Mimir，如部署要求租户标头，请填写 **Org ID (X-Scope-OrgID)**。
4. 按需设置查询 Timeout，以及 ClickHouse 的默认 Database；实际限制见下表。
5. 点击**测试连接**并检查成功或失败状态。成功时显示往返延迟。Datadog 验证 API key 和 Application key 的指标查询权限；空查询结果也可能表示连接测试成功。
6. **保存**后，通过 **浏览 →** 执行一个小范围只读查询，确认目标数据集访问。例如，ClickHouse `/ping` 只验证可达性，不证明查询权限。

建议先测试，但保存本身不代表测试成功。编辑时不会显示已存储的秘密值。保持端点和认证方式不变，并将认证字段留空，可继续使用已存值。编辑测试仅在完整端点不变时复用该实例的凭证；更改主机、协议、端口或路径后必须重新输入。修改连接字段会清除先前测试结果。

### 认证方式

| 方式 | 用途 |
|---|---|
| None | 无需认证的后端 |
| Basic | 用户名和密码，例如启用认证的 ClickHouse |
| Bearer token | 令牌认证；Dynatrace 连接器改用 `Authorization: Api-Token` |
| Custom header | 最多两组标头名称和值；不能覆盖 Host、Content-Length、Authorization 等传输控制标头 |

选择 Datadog 会预选专用 **API key** 和 **Application key** 字段，分别发送为 `DD-API-KEY`、`DD-APPLICATION-KEY`。Dynatrace 默认选择令牌字段，指标访问需要 `metrics.read`。凭证存储在服务端 Secrets Manager，不会返回到表单。

### 正确理解状态

| 状态 | 含义及下一步 |
|---|---|
| 配置已保存 · 未验证 | 必要配置存在；请执行测试及代表性查询 |
| 需要认证配置 | 缺少必要的已存凭证；请管理员补充 |
| 连接成功 | 此提供商的测试通过；不代表所有 API 权限、数据集或工作负载均已验证 |
| 状态或配置不可用 | 无法读取配置；请重试或检查管理员访问权限，不要当作空列表 |
| 已禁用 | 该行已禁用，不提供 AI 诊断快捷入口 |

## Explore 与查询限制

选择实例并审核原生查询，然后点击**运行**。单行查询框可按 Enter 执行，多行 SQL 可按 Ctrl+Enter。查询示例标签会立即执行；自然语言示例标签只填充请求文本。若提供诊断信号标签，点击后也会执行所选查询。

Prometheus、Mimir、Loki 支持 **Instant** 及 5m、15m、1h、6h、24h、7d；Prometheus/Mimir 还支持 30d。更改范围会重新执行当前查询。其他提供商没有此范围选择器。直接范围请求最短 60 秒，Prometheus/Mimir 最长 30 天、Loki 最长 7 天，最多 5,000 个求值点。原生查询文本最多 8,000 字符。

| 设置或限制 | 当前行为 |
|---|---|
| Timeout | 整数秒，1–60，默认 10 |
| ClickHouse Timeout | 在 Explore、图查询、代理路径上作为执行上限；有效最大值 55 秒，56–60 缩短为 55。调用者只能进一步收紧；HTTP 超时设置在其上方 |
| Prometheus/Mimir Timeout | 仅应用于 Explore 的上游 API 查询，最多 10 秒，低于连接器 12 秒的 HTTP 超时 |
| 其他提供商 Timeout | Loki、Tempo、Jaeger、Dynatrace、Datadog 会保存该值，但目前不应用 |
| ClickHouse Database | 可选标识符，最多 128 字符；拒绝 `system`、`information_schema` |
| ClickHouse 行数 | Explore 最多请求 500 行，连接器通用上限为 1,000 行。请用安全的 LIMIT 缩小查询 |
| 查询结果缓存 | 无可配置的结果缓存 TTL；AI 词汇使用的模式缓存是独立机制 |

这些查询设置不表示所有健康探测都采用相同超时。ClickHouse 拒绝变更语句、SYSTEM 和表函数访问。请使用 `SELECT 1` 或已发现且允许访问的用户表，不要认为看似只读的查询在所有后端都可执行。

结果显示行或序列数、连接器往返时间和结果类型。Prometheus/Mimir 范围图最多显示八个序列，支持 Line/Bar 切换；表格和提示提供更多上下文。Loki 提供日志查看器，Tempo/Jaeger 提供精简追踪结果和时长条。解读图表前请检查截断、部分覆盖及空结果提示。结果少或为空不代表工作负载健康或覆盖完整。

## AI 查询草稿、聊天与诊断

### 生成后审核，再运行

输入自然语言请求，点击**使用 AI 生成**或在该输入框按 Enter。查询会填入编辑器，也可能显示词汇或模式警告。**生成过程不会执行生成的查询。** 请审核后单独点击**运行**。自然语言输入限制为 4,000 字符。

草稿参考所选实例的可用模式词汇。缺失、过期或不完整的模式可能触发后台刷新；模式不完整时也可能生成草稿。请核对名称、时间范围、权限及警告。查询结果缓存与此模式缓存是不同概念。

### 诊断默认实例

对于 Prometheus、ClickHouse、Loki、Mimir、Tempo 中**已启用、已配置的默认实例**，**用 AI 诊断**会打开 `/assistant` 并预填固定分区的提示。Prometheus/ClickHouse 使用 `/observability`，Loki/Mimir/Tempo 使用 `/monitoring`；这些是提示中的分区选择器。打开链接不会自动发送。请审核后自行发送，发送时会创建新对话。

原生聊天工具使用每种类型的默认实例。若需其他实例的证据，请在 Explore 中选择；非默认行不提供此诊断快捷入口。代理使用可用的只读查询和模式工具，不保证执行固定的 NLB、安全组或 Kubernetes 诊断流水线。

**Datadog、Dynatrace 支持 Explore 和 AI 查询草稿，但默认未连接原生聊天网关目标或自动诊断报告采集。** Jaeger 同样支持 Explore 和草稿，但没有原生聊天目标或自动报告采集器。注册数据源不会添加这些路径。

工作器的外部证据采集当前仅覆盖 Prometheus、Mimir、Loki、Tempo、ClickHouse，并要求启用 `datasource_diagnosis_enabled` 及其 AgentCore、integrations、workers 依赖。仅注册不会启用采集。报告应明确保留不可用或不完整的证据状态。

受支持的厂商 hosted MCP 预设是 **Connectors** 中的独立路径，使用独立凭证、部署开关和工具允许列表。保存 Datadog 或 Dynatrace 数据源不会激活 hosted MCP。v2 没有 `datasource` 聊天路由，也没有实时 Steampipe 聊天查询路径。

## 排查与安全使用

- 认证失败时检查 API 站点或环境、认证方式和必需的读取权限。指标测试成功不证明 Problems API 访问权限。
- 超时时检查连接器到端点的可达性及网络规则，再缩小查询和时间范围。私有端点需要连接器具备相应网络访问能力。
- 支持 HTTP(S) 私有数据源，但元数据、环回、链路本地及其他被阻止的特殊地址仍不可访问。重定向和不安全 URL 格式会被拒绝。v2 没有 Allowed Networks 例外编辑器。
- 配置读取、保存、删除或默认值修改失败时，依据可见错误重试；不要把未变化的行或旧显示当作成功。
- 对截断、部分、过期或未评估的证据，检查来源及时间范围并缩小请求。不要将不可用测量解释为健康的零值。

## 相关指南

- [自定义代理与技能](../operations/custom-agents)
- [AI 助手](../overview/assistant)
- [AI 诊断报告](../operations/ai-diagnosis)
