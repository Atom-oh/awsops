---
sidebar_position: 2
---

import Screenshot from '@site/src/components/Screenshot';

# Security

在 Security 页面中，可以全面监控 AWS 环境的安全漏洞。您可以在一处集中查看 Public S3 存储桶、开放的 Security Group、未加密的 EBS 卷以及容器 CVE 漏洞。

<Screenshot src="/screenshots/security/security.png" alt="Security" />

## 摘要统计

在页面顶部可以查看主要安全指标：

| 指标 | 说明 | 建议数值 |
|------|------|----------|
| Public Buckets | 可公开访问的 S3 存储桶 | 0 |
| MFA Issues | 未启用 MFA 的用户 | 0 |
| Open SGs | 允许 0.0.0.0/0 入站的 Security Group | 最小化 |
| Unencrypted Vols | 未加密的 EBS 卷 | 0 |
| CVE Critical | Critical 级别漏洞 | 0 |
| CVE High | High 级别漏洞 | 最小化 |

## 可视化图表

### CVE 严重程度分布
以饼图展示按漏洞严重程度划分的分布：

- **CRITICAL**（红色）：需要立即处理
- **HIGH**（橙色）：建议尽快处理
- **MEDIUM**（紫色）：需要计划性处理
- **LOW**（青色）：低优先级

### 安全问题摘要
以柱状图比较各类别的问题数量。

## 各选项卡详细信息

### Public Buckets

允许公开访问的 S3 存储桶列表。

| 列 | 说明 |
|------|------|
| Bucket Name | 存储桶名称 |
| Region | 存储桶区域 |
| Policy Public | 存储桶策略是否公开 |
| Block ACLs | 是否阻止 Public ACL |
| Block Policy | 是否阻止 Public Policy |

:::tip 公开存储桶处理
如果发现公开存储桶，请确认是否为有意为之。若非有意公开，可启用 S3 Block Public Access 设置以立即阻止公开访问。
:::

### MFA Status

未启用 MFA 的 IAM 用户列表。

| 列 | 说明 |
|------|------|
| Username | 用户名 |
| User ID | AWS 用户 ID |
| Created | 创建日期 |
| Password Last Used | 最后登录时间 |

### Open Security Groups

允许来自 0.0.0.0/0 入站流量的 Security Group 规则。

| 列 | 说明 |
|------|------|
| Group ID | Security Group ID |
| Group Name | Security Group 名称 |
| VPC | 所属 VPC |
| Protocol | 允许的协议 |
| From/To Port | 允许的端口范围 |
| CIDR | 源 CIDR（0.0.0.0/0 高亮显示） |

:::info 安全组建议
0.0.0.0/0 CIDR 允许来自所有 IP 的访问。除 Web 服务器端口（80、443）外，建议将其他端口限制为特定 IP 网段。
:::

### Unencrypted Volumes

未加密的 EBS 卷列表。

| 列 | 说明 |
|------|------|
| Volume ID | EBS 卷 ID |
| Name | 卷名称标签 |
| Type | 卷类型（gp3、io2 等） |
| Size (GB) | 卷大小 |
| State | 卷状态 |
| AZ | 可用区 |

:::tip 卷加密方法
现有卷无法直接加密。请先创建加密快照，然后从该快照创建新卷。
:::

### CVE Vulnerabilities

通过 Trivy 扫描检测到的容器镜像漏洞。

| 列 | 说明 |
|------|------|
| CVE ID | 漏洞 ID（例如：CVE-2024-1234） |
| Severity | 严重程度（CRITICAL/HIGH/MEDIUM/LOW） |
| Package | 存在漏洞的软件包名称 |
| Installed | 已安装版本 |
| Fixed | 修复版本（若无则显示 --） |
| Title | 漏洞标题 |

## 详细信息面板

在各表格中点击行，即可在滑出面板中查看详细信息：

- **S3 存储桶**：全部 Public Access 设置
- **IAM 用户**：ARN、创建日期、最后登录时间
- **Security Group**：规则详情及处理建议
- **EBS 卷**：创建日期、状态、加密处理指南
- **CVE**：漏洞描述、受影响的软件包、修复版本

## 数据源

| 数据 | 来源 |
|--------|------|
| S3, IAM, SG, EBS | Steampipe AWS 插件 |
| CVE 漏洞 | Steampipe Trivy 插件（`trivy_scan_vulnerability` 表） |
