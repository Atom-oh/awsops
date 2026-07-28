---
sidebar_position: 4
title: ECR
description: ECR 存储库、镜像、漏洞扫描信息
---

import Screenshot from '@site/src/components/Screenshot';

# ECR (Elastic Container Registry)

用于查看 ECR 存储库和镜像信息的页面。

<Screenshot src="/screenshots/compute/ecr.png" alt="ECR" />

## 主要功能

### 统计卡片
- **Repositories**：全部存储库数量（青色）
- **Scan on Push**：已启用镜像推送时自动扫描的存储库数量（绿色）
- **Immutable Tags**：已启用标签不可变性的存储库数量（紫色）

### 存储库表格
| 列 | 说明 |
|------|------|
| Repository | 存储库名称 |
| URI | 存储库 URI（镜像推送/拉取地址） |
| Tag Mutability | 标签是否可更改（MUTABLE/IMMUTABLE） |
| Scan | 推送时是否启用扫描 |
| Encryption | 加密类型（AES256/KMS） |
| Created | 创建日期 |

### 详情面板
点击存储库可以查看详细信息：
- **Repository 部分**：Name、URI、ARN、Registry ID、Tag Mutability、Created、Region
- **Tags 部分**：存储库上设置的标签

## 使用方法

1. 在侧边栏中点击 **Compute > ECR**
2. 通过顶部统计了解存储库整体状况
3. 识别未启用 Scan on Push 的存储库
4. 点击存储库查看详细 URI 和设置

## 安全设置指南

### Scan on Push
- **建议**：在所有存储库中启用
- 镜像推送时自动执行漏洞扫描
- 发现的 CVE 可在 Security 页面查看

### Immutable Tags
- **建议**：在生产存储库中启用
- 已推送的标签无法被覆盖
- 有利于部署追踪和回滚

### Encryption
- **AES256**：默认 AWS 托管加密
- **KMS**：使用客户托管密钥（CMK）时

## 使用技巧

:::tip 启用 Scan on Push
表格中 Scan 列显示为 "No" 的存储库未启用漏洞扫描。为了安全起见，建议启用。
:::

:::tip 复制镜像 URI
在详情面板的 URI 字段中，可以查看用于 `docker pull` 或 `docker push` 的完整地址。
:::

:::info AI 分析
在 AI Assistant 中可以通过"ECR 存储库列表"、"帮我找出未启用扫描的存储库"、"帮我分析容器镜像漏洞"等进行分析。
:::

## 相关页面

- [ECS](../compute/ecs) - 使用 ECR 镜像的 ECS 服务
- [EKS](../compute/eks) - 使用 ECR 镜像的 EKS 集群
- [Security](../security) - 查看镜像漏洞（CVE）
