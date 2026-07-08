---
sidebar_position: 2
---

# 故障排查 FAQ

以下是使用 AWSops 仪表板过程中可能遇到的问题及解决方法。

<details>
<summary>数据不显示</summary>

请确认 Steampipe 服务是否正在运行。

**1. 检查服务状态**
```bash
steampipe service status
```

**2. 如果服务已停止，请启动**
```bash
steampipe service start --database-listen local --database-port 9193
```

**3. 连接测试**
```bash
steampipe query "SELECT COUNT(*) FROM aws_ec2_instance" --output json --input=false
```

**4. 检查日志**
```bash
tail -20 /tmp/awsops-server.log
```

**常见原因**
- Steampipe 服务未运行
- AWS 凭证过期（检查 EC2 Instance Role）
- 网络连接问题

</details>

<details>
<summary>页面加载缓慢</summary>

**1. 确认使用 Production 构建**

Development 模式非常慢。请使用 Production 构建：

```bash
# 检查当前模式
ps aux | grep next

# 运行 Production 构建
npm run build
npm run start
```

| 模式 | 响应时间 |
|------|----------|
| Development (npm run dev) | 1-2秒 |
| Production (npm run build + start) | 3-6ms |

**2. 检查 Steampipe Pool 配置**

`src/lib/steampipe.ts` 中的 Pool 配置：
```typescript
const pool = new Pool({
  max: 5,                    // 并发连接数
  statement_timeout: 120000,  // 2分钟超时
});
```

**3. 仅特定页面缓慢的情况**
- CloudTrail：事件较多时耗时较长（点击选项卡时 lazy-load）
- Cost：在 MSP 环境中 CE API 被阻断时回退到快照
- Compliance：执行基准测试需要 2-5 分钟（属正常现象）

</details>

<details>
<summary>看不到 Cost 页面</summary>

这发生在 Cost Explorer API 被阻断的环境（如 MSP）中。

**1. 检查 Cost 可用性**

请在仪表板首页确认是否显示 Cost 相关卡片。如果未显示，说明 API 已被阻断。

**2. 使用快照模式**

当 Cost API 被阻断时，将使用快照数据：

```bash
# 保存快照（在可访问 Cost API 的环境中执行）
aws ce get-cost-and-usage ... > data/cost/snapshot.json
```

**3. 检查配置**

`data/config.json` 中的 `costEnabled` 配置：
```json
{
  "costEnabled": true
}
```

在 MSP 环境中会自动检测为 `false`。

</details>

<details>
<summary>CloudTrail 事件加载超时</summary>

CloudTrail 事件查询可能会因数据量大小而耗时较长。

**当前实现方式**
- 页面加载时：仅查询 Trail 列表（快速）
- 点击 Events/Writes 选项卡时：通过单独的 API 调用查询事件（lazy-load）

**CloudFront 超时设置**
- 默认值：30秒
- 推荐值：60秒

在 CDK 中增加 Origin Read Timeout：
```typescript
originReadTimeout: Duration.seconds(60)
```

**替代方案**
- 仅查询最近的事件（限制时间范围）
- 仅过滤特定事件（eventName、userName）
- 通过自然语言向 AI 助手提问

</details>

<details>
<summary>SCP 阻断导致部分数据缺失</summary>

当特定 API 被 SCP（Service Control Policy）阻断时，部分数据可能会缺失。

**受影响的 API 示例**
| API | 影响 |
|-----|------|
| `iam:ListMFADevices` | 无法查询 MFA 状态 |
| `lambda:GetFunction` | 无法查询 Lambda 标签 |
| `iam:ListAttachedUserPolicies` | 无法查询关联的策略 |

**解决方法 1：配置 ignore_error_codes**

`~/.steampipe/config/aws.spc`：
```hcl
connection "aws" {
  plugin = "aws"
  ignore_error_codes = [
    "AccessDenied",
    "AccessDeniedException",
    "UnauthorizedOperation"
  ]
}
```

此配置仅忽略**表级别**的错误。

**解决方法 2：移除列**

列 hydrate 错误需要从查询中移除对应的列。AWSops 已考虑 SCP 环境，将存在问题的列从默认查询中排除。

**已移除的列**
- `mfa_enabled`（IAM 用户列表）
- `attached_policy_arns`（IAM 用户列表）
- `tags`（Lambda 列表）

</details>

<details>
<summary>无法登录</summary>

这是与 Cognito 认证相关的问题。

**1. 检查 Cognito 域名**
- 域名中不能包含 'aws' 字符串
- 例如：`ops-dashboard-auth.auth.ap-northeast-2.amazoncognito.com`

**2. 检查 Lambda@Edge 区域**
- Lambda@Edge **只能部署在 us-east-1**
- 由于与 CloudFront 集成，区域必须一致

**3. 检查回调 URL**
确认 Cognito App Client 的 Callback URL 是否正确：
```
https://<cloudfront-domain>/awsops/api/auth/callback
```

**4. 检查 Cookie**
- 由于设置了 HttpOnly Cookie，无法通过 JavaScript 查看
- 请在浏览器开发者工具 > Application > Cookies 中确认
- 确认是否存在 `id_token`、`access_token`、`refresh_token`

**5. 注销后重新登录**
```bash
# 服务器端删除 Cookie
curl -X POST https://<domain>/awsops/api/auth
```

</details>
