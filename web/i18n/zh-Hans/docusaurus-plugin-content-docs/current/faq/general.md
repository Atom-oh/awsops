---
sidebar_position: 1
---

# 常见问题

关于 AWSops 仪表板的常见问题与解答。

<details>
<summary>AWSops 是什么？</summary>

AWSops 是面向 AWS 和 Kubernetes 环境的实时运维仪表板。主要功能如下：

- **资源监控**：EC2、Lambda、ECS、EKS、RDS、S3 等主要 AWS 服务的状态
- **网络可视化**：VPC、子网、Security Group、Transit Gateway 拓扑
- **安全分析**：CIS 合规性、CVE 漏洞扫描、IAM 分析
- **成本管理**：Cost Explorer、容器成本分析
- **AI 助手**：通过自然语言查询进行 AWS 资源分析和问题排查

基于 Steampipe、Next.js 14 和 Amazon Bedrock AgentCore 构建。

</details>

<details>
<summary>支持哪些 AWS 服务？</summary>

AWSops 通过 Steampipe AWS 插件访问 380 多个 AWS 表。主要支持的服务：

**Compute**
- EC2 实例、Auto Scaling
- Lambda 函数
- ECS 集群/服务/任务
- EKS 集群/节点/Pod

**Storage & Database**
- S3 存储桶
- EBS 卷/快照
- RDS 实例
- DynamoDB 表
- ElastiCache (Valkey/Redis/Memcached)
- OpenSearch 域
- MSK 集群

**Network**
- VPC、子网、Security Group
- Transit Gateway、VPN
- ELB/ALB/NLB
- CloudFront、WAF

**Security & Monitoring**
- IAM 用户/角色/策略
- CloudTrail、CloudWatch
- CIS 合规性

</details>

<details>
<summary>系统要求是什么？</summary>

**服务器要求**
- EC2：建议 t4g.2xlarge 或更高配置 (ARM64)
- 内存：16GB 以上
- 存储：50GB 以上

**必需软件**
- Steampipe + AWS/Kubernetes/Trivy 插件
- Node.js 20+
- Docker（用于 AgentCore 构建）

**网络**
- 建议部署在 Private Subnet 中
- 通过 ALB + CloudFront 访问
- Steampipe 仅可从本地 (127.0.0.1:9193) 访问

**客户端**
- 现代 Web 浏览器 (Chrome, Firefox, Safari, Edge)
- 最低分辨率：1280x720

</details>

<details>
<summary>数据存储在哪里？</summary>

**实时数据（缓存 5 分钟）**
- 通过 Steampipe 内置 PostgreSQL（端口 9193）实时查询 AWS/K8s API
- 结果通过 node-cache 在内存中缓存 5 分钟
- 可通过刷新按钮使缓存失效

**持久化数据**
- `data/inventory/`：资源清单快照 (JSON)
- `data/cost/`：Cost 数据快照（用于 MSP 环境回退）
- `data/memory/`：AI 对话历史（按用户隔离，保留 365 天）
- `data/config.json`：应用配置（AgentCore ARN 等）

**无外部存储**
- 无需安装额外的数据库（使用 Steampipe 内置 PostgreSQL）
- 所有数据均存储在 EC2 实例内

</details>

<details>
<summary>会产生费用吗？</summary>

**免费**
- Steampipe 及其插件
- Powerpipe（CIS 基准测试）
- Next.js 应用程序

**按 AWS 用量计费**
- EC2 实例费用（以 t4g.2xlarge 为例约 $0.27/小时）
- ALB 费用
- CloudFront 费用

**AI 功能（可选）**
- Amazon Bedrock：根据模型用量按 token 计费
- AgentCore Runtime：按执行时间计费
- Lambda：按调用次数和执行时间计费

**成本优化建议**
- 禁用 AI 功能后不会产生 Bedrock/AgentCore 费用
- 可使用 Spot 实例（非生产环境）
- 不使用时停止实例

</details>

<details>
<summary>支持多个 AWS 账户吗？</summary>

**单账户模式（默认）**
- 仅查询与 EC2 实例关联的 IAM Role 所属账户

**多账户模式（需要配置）**
通过 Steampipe 的 AWS 插件配置可支持多个账户：

```hcl
# ~/.steampipe/config/aws.spc
connection "aws_prod" {
  plugin  = "aws"
  profile = "production"
  regions = ["ap-northeast-2"]
}

connection "aws_dev" {
  plugin  = "aws"
  profile = "development"
  regions = ["ap-northeast-2"]
}

connection "aws" {
  plugin      = "aws"
  type        = "aggregator"
  connections = ["aws_*"]
}
```

使用聚合器 (aggregator) 连接可以整合并查询多个账户的数据。

**Organizations 集成**
如果使用 AWS Organizations，可通过 Cross-Account Role 访问成员账户。

</details>
