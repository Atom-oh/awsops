---
sidebar_position: 3
title: AgentCore
description: Amazon Bedrock AgentCore 架构及 MCP 工具详解
---

import Screenshot from '@site/src/components/Screenshot';
import AgentCoreFlow from '@site/src/components/diagrams/AgentCoreFlow';

# AgentCore

AgentCore 基于 Amazon Bedrock AgentCore Runtime 和 Gateway，负责 AI 助手的工具执行。

<Screenshot src="/screenshots/overview/agentcore.png" alt="AgentCore" />

## 架构

![AgentCore 架构](/diagrams/agentcore-architecture.png)

### AI 路由流程

<AgentCoreFlow />

### 部署要求

| 项目 | 要求 |
|------|----------|
| **Docker** | 必须使用 arm64（`docker buildx --platform linux/arm64 --load`） |
| **agent.py** | 更新各账户的 Gateway URL 后需要重新构建 Docker 镜像 |
| **Code Interpreter** | 名称中不能使用连字符，只能使用下划线 |
| **Memory Store** | 名称中不能使用连字符（`awsops_memory`），最长保留 365 天 |
| **Runtime 更新** | 必须提供 `--role-arn` + `--network-configuration` |

## AgentCore Runtime

### 组成

| 项目 | 说明 |
|------|------|
| **引擎** | Strands Agent Framework |
| **容器** | Docker arm64（存储在 ECR） |
| **运行环境** | AgentCore 托管服务 |
| **模型** | Claude Sonnet/Opus 4.6 |

### 状态

- **READY**: 正常运行中
- **CREATING**: 创建中
- **UPDATING**: 更新中
- **FAILED**: 错误状态

## Gateway 详解

### Network Gateway (17 tools)

提供 VPC、Transit Gateway、VPN、网络分析工具。

| 工具 | 说明 |
|------|------|
| `list_vpcs` | 查询 VPC 列表 |
| `get_vpc_network_details` | VPC 网络详情 |
| `describe_network` | 网络配置说明 |
| `find_ip_address` | IP 地址搜索 |
| `get_eni_details` | ENI 详细信息 |
| `get_vpc_flow_logs` | 查询 VPC Flow Logs |
| `list_transit_gateways` | TGW 列表 |
| `get_tgw_details` | TGW 详情 |
| `get_tgw_routes` | TGW 路由表 |
| `get_all_tgw_routes` | 全部 TGW 路由 |
| `list_tgw_peerings` | TGW 对等连接列表 |
| `list_vpn_connections` | VPN 连接列表 |
| `list_network_firewalls` | Network Firewall 列表 |
| `get_firewall_rules` | 查询防火墙规则 |
| `analyze_reachability` | Reachability Analyzer |
| `query_flow_logs` | Flow Logs 查询 |
| `get_path_trace_methodology` | 路径追踪方法论 |

### Container Gateway (24 tools)

提供 EKS、ECS、Istio 服务网格相关工具。

| 类别 | 工具 |
|---------|------|
| **EKS** | `list_eks_clusters`, `get_eks_vpc_config`, `get_eks_insights`, `get_cloudwatch_logs`, `get_cloudwatch_metrics`, `get_eks_metrics_guidance`, `get_policies_for_role`, `search_eks_troubleshoot_guide`, `generate_app_manifest` |
| **ECS** | `ecs_resource_management`, `ecs_troubleshooting_tool`, `wait_for_service_ready` |
| **Istio** | `istio_overview`, `list_virtual_services`, `list_destination_rules`, `list_istio_gateways`, `list_service_entries`, `list_authorization_policies`, `list_peer_authentications`, `check_sidecar_injection`, `list_envoy_filters`, `list_istio_crds`, `istio_troubleshooting`, `query_istio_resource` |

### IaC Gateway (12 tools)

提供 Infrastructure as Code 相关工具。

| 工具 | 说明 |
|------|------|
| `validate_cloudformation_template` | CFn 模板验证 |
| `check_cloudformation_template_compliance` | CFn 合规性检查 |
| `troubleshoot_cloudformation_deployment` | CFn 部署故障排查 |
| `search_cdk_documentation` | CDK 文档搜索 |
| `search_cloudformation_documentation` | CFn 文档搜索 |
| `cdk_best_practices` | CDK 最佳实践 |
| `read_iac_documentation_page` | 读取 IaC 文档页面 |
| `SearchAwsProviderDocs` | Terraform AWS Provider 文档 |
| `SearchAwsccProviderDocs` | Terraform AWSCC Provider 文档 |
| `SearchSpecificAwsIaModules` | AWS IA 模块搜索 |
| `SearchUserProvidedModule` | 用户模块搜索 |
| `terraform_best_practices` | Terraform 最佳实践 |

### Data Gateway (24 tools)

提供 AWS 数据库及流式服务工具。

| 类别 | 工具 |
|---------|------|
| **DynamoDB** | `list_tables`, `describe_table`, `query_table`, `get_item`, `dynamodb_data_modeling`, `compute_performances_and_costs` |
| **RDS/Aurora** | `list_db_instances`, `list_db_clusters`, `describe_db_instance`, `describe_db_cluster`, `execute_sql`, `list_snapshots` |
| **ElastiCache** | `list_cache_clusters`, `describe_cache_cluster`, `list_replication_groups`, `describe_replication_group`, `list_serverless_caches`, `elasticache_best_practices` |
| **MSK** | `list_clusters`, `get_cluster_info`, `get_configuration_info`, `get_bootstrap_brokers`, `list_nodes`, `msk_best_practices` |

### Security Gateway (14 tools)

提供 IAM 及安全分析工具。

| 工具 | 说明 |
|------|------|
| `list_users` | IAM 用户列表 |
| `get_user` | 用户详情 |
| `list_roles` | IAM 角色列表 |
| `get_role_details` | 角色详情 |
| `list_groups` | IAM 组列表 |
| `get_group` | 组详情 |
| `list_policies` | 策略列表 |
| `list_user_policies` | 用户策略列表 |
| `list_role_policies` | 角色策略列表 |
| `get_user_policy` | 用户内联策略 |
| `get_role_policy` | 角色内联策略 |
| `list_access_keys` | Access Key 列表 |
| `simulate_principal_policy` | 策略模拟 |
| `get_account_security_summary` | 账户安全摘要 |

### Monitoring Gateway (16 tools)

提供 CloudWatch 及 CloudTrail 相关工具。

| 类别 | 工具 |
|---------|------|
| **CloudWatch Metrics** | `get_metric_data`, `get_metric_metadata`, `analyze_metric`, `get_recommended_metric_alarms`, `get_active_alarms`, `get_alarm_history` |
| **CloudWatch Logs** | `describe_log_groups`, `analyze_log_group`, `execute_log_insights_query`, `get_logs_insight_query_results`, `cancel_logs_insight_query` |
| **CloudTrail** | `lookup_events`, `list_event_data_stores`, `lake_query`, `get_query_status`, `get_query_results` |

### Cost Gateway (9 tools)

提供成本分析及预测工具。

| 工具 | 说明 |
|------|------|
| `get_today_date` | 查询今天日期 |
| `get_cost_and_usage` | 查询成本及使用量 |
| `get_cost_and_usage_comparisons` | 成本比较 |
| `get_cost_comparison_drivers` | 成本变动原因 |
| `get_cost_forecast` | 成本预测 |
| `get_dimension_values` | 查询维度值 |
| `get_tag_values` | 查询标签值 |
| `get_pricing` | AWS 服务价格 |
| `list_budgets` | 预算列表 |

### Ops Gateway (9 tools)

提供通用 AWS 运维及文档相关工具。

| 工具 | 说明 |
|------|------|
| `search_documentation` | AWS 文档搜索 |
| `read_documentation` | AWS 文档阅读 |
| `recommend` | 推荐 |
| `list_regions` | AWS 区域列表 |
| `get_regional_availability` | 各区域服务可用性 |
| `prompt_understanding` | 提示词理解 |
| `call_aws` | AWS API 调用 |
| `suggest_aws_commands` | AWS CLI 命令建议 |
| `run_steampipe_query` | 执行 Steampipe SQL |

## Code Interpreter

提供用于执行 Python 代码的沙箱环境。

### 特性

- **隔离环境**: 安全的 Python 执行
- **数据分析**: 支持 pandas、numpy 等库
- **可视化**: 使用 matplotlib、plotly 等生成图表
- **文件处理**: 解析 JSON、CSV 等数据

### 使用示例

```
"把 AWS 成本数据可视化为按月趋势图表"
"解析这份 JSON 数据并计算统计信息"
```

## 调用统计

在 AgentCore 页面可以查看以下统计信息：

| 统计 | 说明 |
|------|------|
| **总调用数** | 全部 AI 请求数 |
| **平均响应时间** | 平均处理时间 |
| **使用的工具** | 唯一工具数、总调用次数 |
| **成功率** | 成功/失败比率 |
| **多路由** | 并行 Gateway 调用数 |
| **各路由调用分布** | 每个路由的使用比例 |

## 对话历史搜索

在 AgentCore 页面可以搜索已保存的对话历史。

### 搜索功能

- **关键词搜索**: 按提问内容搜索
- **最近对话**: 按时间排序
- **路由过滤**: 按路由筛选（在 UI 中）

### 显示信息

- 提问内容
- 响应摘要
- 路由
- 使用的工具数
- 响应时间
- 时间戳

## 配置文件

AgentCore 配置在 `data/config.json` 中管理。

```json
{
  "costEnabled": true,
  "agentRuntimeArn": "arn:aws:bedrock-agentcore:REGION:ACCOUNT:runtime/RUNTIME_ID",
  "codeInterpreterName": "awsops_code_interpreter-XXXXX",
  "memoryId": "awsops_memory-XXXXX",
  "memoryName": "awsops_memory"
}
```

:::tip 按账户部署
部署到新账户时，只需更新此 config 文件即可，无需修改代码。
:::

## 已知限制

| 项目 | 限制 |
|------|------|
| **Docker 架构** | 必须使用 arm64 |
| **Code Interpreter 名称** | 不能使用连字符，只能使用下划线 |
| **Memory 名称** | 不能使用连字符，只能使用下划线 |
| **对话历史保留** | 最长 365 天 |
| **AgentCore 响应** | 仅返回最终文本（工具推断，以打字效果流式呈现） |

## 下一步

- [AI 助手](../overview/ai-assistant) - 使用 AI 功能
- [仪表板](../overview/dashboard) - 返回仪表板
