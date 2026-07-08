---
sidebar_position: 3
---

# AI 助手 FAQ

关于 AWSops AI 助手的常见问题与解答。

<details>
<summary>可以提出哪些类型的问题？</summary>

AI 助手通过 10 个专业路由回答各种问题：

**1. Code（代码执行）**
- "帮我分析这些数据"
- "用 Python 画一个图表"
- 通过代码解释器执行 Python 代码

**2. Network（网络分析）**
- "从 EC2 实例 A 无法连接到 B"
- "帮我检查 VPC 对等连接的路由"
- "帮我分析 Security Group 规则"

**3. Container（容器分析）**
- "EKS Pod 处于 Pending 状态"
- "ECS 服务部署失败的原因是什么？"
- "分析 Istio 服务网格问题"

**4. IaC（Infrastructure as Code）**
- "帮我审查这段 CDK 代码"
- "CloudFormation 堆栈创建失败的原因是什么？"
- "告诉我 Terraform 最佳实践"

**5. Data（数据库）**
- "RDS 连接很慢"
- "DynamoDB 限流的原因是什么？"
- "如何解决 ElastiCache 内存不足的问题"

**6. Security（安全）**
- "帮我分析这个 IAM 策略的权限"
- "模拟 S3 存储桶的访问权限"
- "如何配置跨账户角色"

**7. Monitoring（监控）**
- "如何设置 CloudWatch 告警"
- "帮我在 CloudTrail 中查找特定事件"
- "分析 EC2 CPU 使用率趋势"

**8. Cost（成本）**
- "帮我分析本月的成本"
- "成本激增的原因是什么？"
- "推荐一些成本优化方案"

**9. AWS Data（资源列表/状态）**
- "显示 EC2 实例列表"
- "检查 RDS 实例状态"
- "按运行时统计 Lambda 函数"

**10. General（通用）**
- 不属于以上类别的 AWS 相关问题

</details>

<details>
<summary>AI 给出错误答案时该怎么办？</summary>

AI 助手基于 Amazon Bedrock（Claude Sonnet/Opus 4.6）构建。

**数据准确性**
- AWS 资源数据通过 Steampipe **实时**查询
- 数据本身是准确的，但 AI 的**解读**可能出错

**错误答案的应对方法**

1. **通过追加提问进行确认**
   - "这个信息的来源是什么？"
   - "请更详细地解释一下"

2. **直接核实**
   - 在仪表板的相应页面直接确认数据
   - 在 AWS 控制台中验证

3. **提供反馈**
   - 在对话中说"错了"或"再确认一下"，AI 会重新分析
   - 指出具体错误可以获得更准确的回答

**AI 的局限性**
- 无法即时感知实时事件（当前正在发生的故障）
- AWS 服务的最新功能可能未包含在训练数据中
- 可能无法考虑账户特有的配置或 SCP 限制

</details>

<details>
<summary>对话记录会被保存吗？</summary>

是的，对话记录按用户分别保存。

**存储位置**
- 服务器：`data/memory/` 目录
- 按用户隔离：基于 Cognito 用户 ID（sub）

**保留期限**
- 最长 365 天
- 使用 AgentCore Memory Store

**查看方法**
- 可在 AgentCore 仪表板页面搜索对话历史
- 支持按日期、关键词筛选

**隐私保护**
- 对话记录仅限该用户本人访问
- 无法查看其他用户的对话记录
- 服务器管理员可通过文件系统访问

**删除请求**
目前 UI 中没有直接删除功能。需要向管理员申请，或在服务器上直接删除：
```bash
rm data/memory/<user-sub>/*
```

:::info 技术细节
关于 Memory Store 的内部机制（内存缓存 + 防抖 flush）以及按用户隔离的原理，请参阅 [AgentCore & Memory FAQ](./agentcore-memory)。
:::

</details>

<details>
<summary>可以执行代码吗？</summary>

是的，可以通过 Code Interpreter 执行 Python 代码。

**使用方法**
- "用 Python 帮我分析"
- "用代码帮我计算"
- "帮我画个图表"
- 数据分析、可视化相关问题

**支持的功能**
- Python 3.x 执行环境
- 主要库：pandas、numpy、matplotlib、seaborn
- 文件读写（限临时目录内）
- 图表/图形生成

**限制事项**
- 沙箱环境（网络访问受限）
- 执行时间限制
- 无法直接调用 AWS API（AI 会先查询数据再进行分析）

**示例问题**
- "用饼图展示按 EC2 实例类型划分的成本"
- "按时间段分析最近 30 天的 CloudTrail 事件"
- "计算 Lambda 函数内存使用量的统计数据"

</details>

<details>
<summary>使用哪些工具？</summary>

AI 助手使用 125 个 MCP（Model Context Protocol）工具。

**Gateway 构成（8 个）**

| Gateway | 用途 | 主要工具 |
|---------|------|----------|
| Network | 网络分析 | Reachability Analyzer, Flow Logs, TGW, VPN |
| Container | 容器分析 | EKS, ECS, Istio 诊断 |
| IaC | 基础设施代码 | CDK, CloudFormation, Terraform |
| Data | 数据库 | DynamoDB, RDS, ElastiCache, MSK |
| Security | 安全 | IAM 模拟, 策略分析 |
| Monitoring | 监控 | CloudWatch, CloudTrail |
| Cost | 成本 | CE API, 预算, 预测 |
| Ops | 运维 | 通用 AWS 操作 |

**Lambda 函数（19 个）**
每个 Gateway 的后端由 Lambda 函数执行。

**工具使用展示**
UI 中会显示 AI 回答使用了哪些工具。这是基于回答内容的关键词推断得出的。

:::info 技术细节
关于 Gateway↔Lambda 的关系、MCP 协议的工作方式以及如何添加新工具，请参阅 [AgentCore & Memory FAQ](./agentcore-memory)。
:::

</details>

<details>
<summary>响应缓慢时该怎么办？</summary>

以下是 AI 响应延迟的常见原因及解决方法。

**1. AgentCore Runtime Cold Start**
- 首次请求需要时间启动容器（10-30 秒）
- 之后的请求会很快（Warm 状态）
- 解决方法：通过定期健康检查保持 Warm 状态

**2. 复杂的问题**
- 需要经过多个 Gateway 的问题耗时更长
- 解决方法：将问题拆分为简单的问题
- 示例："分析网络问题并检查成本" → 拆分为两个问题

**3. 大量数据查询**
- CloudTrail 事件、大量资源列表
- 解决方法：明确指定时间范围或筛选条件
- 示例："最近 1 小时的 CloudTrail 事件" 或 "仅带有 production 标签的 EC2"

**4. 网络延迟**
- CloudFront → ALB → EC2 → AgentCore 路径
- 解决方法：检查 CloudFront Origin Timeout 设置（建议 60 秒）

**流式响应**
AI 响应通过 SSE（Server-Sent Events）流式传输。无需等待完整响应，文本会实时显示。

**超时**
- 默认超时：120 秒
- 发生超时时，请简化问题或重试

:::info 技术细节
关于 FTTT（Time To First Token）的组成部分、各阶段耗时以及改进方法，请参阅 [架构 Deep Dive](./architecture)。
:::

</details>
