---
sidebar_position: 7
title: 数据源
description: 外部数据源集成管理（Prometheus、Loki、Tempo、ClickHouse、Jaeger、Dynatrace、Datadog）
---

import Screenshot from '@site/src/components/Screenshot';
import DatasourceFlow from '@site/src/components/diagrams/DatasourceFlow';
import DatasourceExploreFlow from '@site/src/components/diagrams/DatasourceExploreFlow';

# 数据源

这是一个 Grafana 风格的数据源管理页面，可将外部监控与可观测性系统接入 AWSops 进行统一管理。

<Screenshot src="/screenshots/monitoring/datasources.png" alt="数据源" />

## 概述

AWSops 数据源功能可集中管理外部可观测性平台。注册数据源后，即可在仪表板中执行查询，AI 助手也可将其用于分析。

<DatasourceFlow />

主要特性：
- 支持 **7 种数据源**（Prometheus、Loki、Tempo、ClickHouse、Jaeger、Dynatrace、Datadog）
- **CRUD 管理**：添加、修改、删除数据源（仅限管理员）
- **连接测试**：一键连接确认及响应时间测量
- **查询执行**：支持各数据源专属的查询语言
- **安全性**：SSRF 防护、凭证脱敏

## 支持的数据源

| 数据源 | 查询语言 | 默认端口 | 主要功能 |
|-----------|----------|----------|----------|
| **Prometheus** | PromQL | 9090 | 指标采集、告警、时间序列数据 |
| **Loki** | LogQL | 3100 | 日志聚合、基于标签的检索 |
| **Tempo** | TraceQL | 3200 | 分布式追踪、Span 检索 |
| **ClickHouse** | SQL | 8123 | 列式分析、海量数据处理 |
| **Jaeger** | Trace ID | 16686 | 分布式追踪、服务依赖关系 |
| **Dynatrace** | DQL | 443 | 全栈监控、基于 AI 的分析 |
| **Datadog** | Query | 443 | 基础设施监控、APM、日志 |

## 添加数据源

:::info 仅限管理员
创建、修改、删除数据源需要管理员角色。管理员是指在 `data/config.json` 的 `adminEmails` 中注册的用户。
:::

### 配置字段

| 字段 | 必填 | 说明 |
|------|------|------|
| **Name** | O | 数据源标识名称 |
| **Type** | O | 数据源类型（从 7 种中选择） |
| **URL** | O | 端点 URL（例如 `http://prometheus:9090`） |
| **Authentication** | - | 认证方式（None、Basic、Bearer Token、Custom Header） |
| **Timeout** | - | 请求超时时间（默认值：30 秒） |
| **Cache TTL** | - | 缓存有效时间（默认值：5 分钟） |
| **Database** | - | 数据库名称（仅限 ClickHouse） |

### 添加流程

1. 在 **Datasources** 页面点击 **Add Datasource** 按钮
2. 选择数据源类型
3. 输入名称、URL、认证信息
4. 通过 **Test Connection** 确认连接
5. 点击 **Save** 保存

## 连接测试

点击 **Test Connection** 按钮后，将按数据源类型检查以下内容：

| 数据源 | 测试端点 | 检查内容 |
|-----------|-----------------|----------|
| Prometheus | `/-/healthy` | 服务器状态、响应时间 |
| Loki | `/ready` | 服务器就绪状态、响应时间 |
| Tempo | `/ready` | 服务器就绪状态、响应时间 |
| ClickHouse | `SELECT 1` | 查询是否可执行、响应时间 |
| Jaeger | `/api/services` | 服务列表查询、响应时间 |
| Dynatrace | `/api/v2/entities` | API 是否可访问、响应时间 |
| Datadog | `/api/v1/validate` | API 密钥有效性、响应时间 |

测试结果会显示连接成功/失败状态以及响应延迟时间（ms）。

## 执行查询

可以使用各数据源专属的查询语言直接执行查询。

### PromQL (Prometheus)

```promql
rate(http_requests_total{job="api-server"}[5m])
```

以时间序列形式查询 CPU 使用率、请求率、错误率等指标数据。

### LogQL (Loki)

```logql
{namespace="production"} |= "error" | json | line_format "{{.message}}"
```

支持基于标签的日志检索和管道过滤。

### TraceQL (Tempo)

```
{span.http.status_code >= 500 && resource.service.name = "api"}
```

基于条件检索分布式追踪。

### ClickHouse SQL

```sql
SELECT toStartOfHour(timestamp) AS hour, count() AS events
FROM logs
WHERE timestamp > now() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour
```

对海量数据执行快速分析查询。

### Jaeger

通过服务名称或 Trace ID 检索分布式追踪。

### Dynatrace (DQL)

```
fetch logs | filter contains(content, "error") | limit 100
```

### Datadog

使用指标查询或日志检索语法。

## 认证配置

连接数据源时支持 4 种认证方式：

| 认证方式 | 说明 | 使用示例 |
|----------|------|----------|
| **None** | 无认证 | 内部网络中的 Prometheus/Loki |
| **Basic** | 用户名/密码 | ClickHouse、启用了认证的 Prometheus |
| **Bearer Token** | API 令牌 | Dynatrace、Datadog、Tempo |
| **Custom Header** | 自定义请求头 | 自定义代理、API 网关 |

:::tip 凭证脱敏
已保存的密码和令牌在 UI 中会进行脱敏处理。仅在修改时可以输入新值。
:::

## 安全性

### SSRF 防护

对数据源 URL 会应用以下安全检查：

- **拦截私有 IP**：拦截 `10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`、`127.0.0.1` 等内部 IP
- **拦截元数据端点**：拦截对 `169.254.169.254`（EC2 实例元数据）的访问
- **拦截链路本地地址**：拦截 `169.254.x.x` 网段
- **协议限制**：仅允许 `http://` 和 `https://`

:::caution SSRF 保护
由于外部数据源 URL 的请求是从服务器发出的，为防止 SSRF（Server-Side Request Forgery）攻击，对内部网络的访问将被拦截。
:::

### ClickHouse SQL 注入防护

执行 ClickHouse 查询时，危险的 SQL 语句（DROP、ALTER、INSERT、UPDATE、DELETE、TRUNCATE 等）会被拦截。仅允许只读查询（SELECT）。

## AI 集成

AI 助手可以利用已注册的数据源执行分析。

### 使用示例

- "在 Prometheus 中显示过去 1 小时的 CPU 使用率趋势"
- "在 Loki 中检索 production 命名空间的错误日志"
- "在 ClickHouse 中按小时统计今天的事件数"

### 工作原理

1. AI 助手分析问题并选择合适的数据源
2. 自动生成与数据源类型匹配的查询
3. 基于查询结果提供分析和洞察

:::tip datasource 路由集成
与数据源相关的问题通过 `datasource` 路由处理。AI 可以将 Steampipe 数据与外部数据源结合起来进行分析。
:::

## 配置参考

### 通用配置

| 配置 | 默认值 | 说明 |
|------|--------|------|
| **timeout** | 30 秒 | 请求超时时间（最大 120 秒） |
| **cacheTTL** | 300 秒（5 分钟） | 查询结果缓存有效时间 |

### ClickHouse 专用

| 配置 | 默认值 | 说明 |
|------|--------|------|
| **database** | `default` | 目标数据库名称 |

### 限制事项

- 最大可注册数据源数量：无限制
- 查询结果最大行数：1,000 行
- ClickHouse：仅允许 SELECT 查询（拦截 DDL/DML）
- URL：拦截私有 IP 及元数据端点

## Explore 页面

在 Explore 页面中，可以对已注册的数据源直接执行查询并可视化结果。支持 AI 查询生成和多序列图表。

<DatasourceExploreFlow />

### 主要功能

- **数据源选择下拉框**：从所有已注册的数据源中选择查询目标。
- **时间范围预设**：从 15m、1h、6h、24h、7d、30d 中选择以指定查询时间段。
- **原生查询编辑器**：提供按数据源类型应用语法高亮的查询编辑器（PromQL、LogQL、SQL 等）。
- **示例查询芯片**：可一键输入各数据源类型的常用查询。
- **结果元数据**：查询执行后，行数、执行时间（ms）、查询语言会显示在顶部。

### AI 查询生成

启用 **AI Assist** 开关后，即可使用自然语言编写查询。Bedrock Sonnet 会自动生成与数据源类型匹配的查询，并显示说明横幅。

**各数据源类型的示例提示词：**

| 数据源 | 示例提示词 |
|-----------|-------------|
| Prometheus | "过去 1 小时 CPU 使用率排名前 5 的 Pod" |
| Loki | "在 production 命名空间中检索 error 级别日志" |
| ClickHouse | "按小时统计今天的事件数" |
| Tempo | "检索发生 500 错误的追踪" |

**使用方法：**

1. 将 AI Assist 开关切换为 ON
2. 用自然语言描述所需数据
3. 按 **Ctrl+Enter** 或点击执行按钮
4. Bedrock Sonnet 生成 PromQL/LogQL/SQL 查询
5. 生成的查询会与说明横幅一同显示

:::tip AI Assist 快捷键
使用 **Ctrl+Enter** 可以快速生成并执行查询。
:::

### 多序列图表

在 Prometheus 数据源中，最多可同时可视化 **8 个序列**。

- **Line/Bar 图表切换**：根据数据特性选择图表类型。
- **自定义调色板**：为每个序列自动分配专属颜色，使用 8 种主题颜色。
- **序列数量指示器**：图表底部显示当前正在渲染的序列数量。

:::info 序列限制
出于性能考虑，Prometheus 多序列图表最多限制为 8 个序列。超过 8 个的结果仅显示前 8 个。
:::

## 数据源诊断

当数据源连接出现问题时，点击 **Diagnose** 按钮（听诊器图标）即可自动执行 8 步诊断。

:::info 仅限管理员
Diagnose 功能需要管理员角色。
:::

### datasource-diag AI 路由

诊断请求会转发到 `datasource-diag` AI 路由。为系统地分析数据源连接问题，该路由会依次执行 8 个专用诊断工具。

### 8 步自动诊断

| 步骤 | 工具 | 说明 |
|------|------|------|
| 1 | **URL Validation** | 验证 URL 格式、协议、Allowed Networks 列表 |
| 2 | **DNS Resolution** | 将主机名解析为 IP 并确认可达性 |
| 3 | **NLB Health** | 检查 Network Load Balancer 目标组状态 |
| 4 | **SG Chain** | 验证 Security Group 入站/出站规则链 |
| 5 | **Network Path** | 追踪 VPC 路由、子网、NACL 路径 |
| 6 | **HTTP Test** | 发送 HTTP 请求并验证响应代码/正文 |
| 7 | **K8s Endpoint** | 确认 Kubernetes Service 及 Pod 端点状态 |
| 8 | **Full Report** | 汇总所有结果生成诊断报告 |

诊断开始后会自动跳转到 AI 助手界面，可实时查看诊断过程。

## Allowed Networks

管理员可以为被 SSRF 防护拦截的私有网络配置例外允许列表。

:::info 仅限管理员
Allowed Networks 配置需要管理员角色。
:::

### 支持的模式

| 模式类型 | 示例 | 说明 |
|----------|------|------|
| **CIDR** | `10.0.0.0/16` | 允许特定子网网段 |
| **单个 IP** | `10.0.1.50` | 允许特定 IP 地址 |
| **主机名** | `prometheus.internal` | 允许特定内部主机名 |

### 与 SSRF 防护的关系

默认情况下，私有 IP 网段（`10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`）会因 SSRF 防护而被拦截。注册到 Allowed Networks 的地址将作为该拦截规则的例外处理，从而可以安全地访问位于内部网络中的数据源。

:::caution 安全注意
如果在 Allowed Networks 中添加过于宽泛的 CIDR 网段，可能会削弱 SSRF 保护。请仅注册所需的最小范围。
:::

## AI 代理集成

已注册的数据源会在 AI 助手（`/ai`）中被自动利用。当问题中包含数据源关键词时，AI 会自动生成并执行查询。

### 单一数据源查询

```
"在 Prometheus 中查看 CPU 使用量"
→ datasource 路由 → 自动生成 PromQL → 分析结果
```

### 多数据源关联分析

可以同时查询多个数据源并进行关联分析：

```
"对 Prometheus 指标和 Loki 错误日志进行关联分析"
→ Prometheus PromQL + Loki LogQL 并行执行 → 综合分析
```

### 与 AWS 资源的交叉分析

可以将数据源查询与 AWS 资源结合分析，找出根本原因：

```
"对比 Prometheus CPU 峰值与 CloudWatch 告警"
→ datasource + monitoring 多路由 → 交叉关联分析
```

:::tip AI 关键词
AI 助手可识别的关键词：**prometheus**、**loki**、**tempo**、**clickhouse**、**jaeger**、**dynatrace**、**datadog**
:::

## 相关页面

- [监控仪表板](./monitoring.md) - 系统监控现状
- [CloudWatch](./cloudwatch) - AWS CloudWatch 指标
- [AI 助手](../overview/ai-assistant) - AI 分析功能
