---
sidebar_position: 4
title: ECR
description: ECR リポジトリ、イメージ、脆弱性スキャン情報
---

import Screenshot from '@site/src/components/Screenshot';

# ECR (Elastic Container Registry)

ECR リポジトリとイメージ情報を確認できるページです。

<Screenshot src="/screenshots/compute/ecr.png" alt="ECR" />

## 主な機能

### 統計カード
- **Repositories**: リポジトリの総数(シアン)
- **Scan on Push**: イメージのプッシュ時に自動スキャンが有効化されているリポジトリ数(緑)
- **Immutable Tags**: タグの不変性が有効化されているリポジトリ数(紫)

### リポジトリテーブル
| カラム | 説明 |
|------|------|
| Repository | リポジトリ名 |
| URI | リポジトリ URI(イメージのプッシュ/プル用アドレス) |
| Tag Mutability | タグの変更可否(MUTABLE/IMMUTABLE) |
| Scan | プッシュ時のスキャンの有効/無効 |
| Encryption | 暗号化タイプ(AES256/KMS) |
| Created | 作成日 |

### 詳細パネル
リポジトリをクリックすると詳細情報を確認できます:
- **Repository セクション**: Name、URI、ARN、Registry ID、Tag Mutability、Created、Region
- **Tags セクション**: リポジトリに設定されたタグ

## 使い方

1. サイドバーで **Compute > ECR** をクリックします
2. 上部の統計でリポジトリ全体の状況を把握します
3. Scan on Push が無効になっているリポジトリを特定します
4. リポジトリをクリックして詳細な URI と設定を確認します

## セキュリティ設定ガイド

### Scan on Push
- **推奨**: すべてのリポジトリで有効化
- イメージのプッシュ時に自動で脆弱性スキャンを実行
- 検出された CVE は Security ページで確認可能

### Immutable Tags
- **推奨**: 本番用リポジトリで有効化
- 一度プッシュされたタグは上書きできません
- デプロイの追跡とロールバックに有利

### Encryption
- **AES256**: デフォルトの AWS マネージド暗号化
- **KMS**: カスタマーマネージドキー(CMK)を使用する場合

## 利用のヒント

:::tip Scan on Push の有効化
テーブルで Scan カラムが「No」のリポジトリは脆弱性スキャンが無効になっています。セキュリティのため有効化を推奨します。
:::

:::tip イメージ URI のコピー
詳細パネルの URI フィールドで、`docker pull` または `docker push` に使用する完全なアドレスを確認できます。
:::

:::info AI 分析
AI Assistant で「ECR リポジトリの一覧」「スキャンが無効なリポジトリを探して」「コンテナイメージの脆弱性を分析して」などで分析できます。
:::

## 関連ページ

- [ECS](../compute/ecs) - ECR イメージを使用する ECS サービス
- [EKS](../compute/eks) - ECR イメージを使用する EKS クラスター
- [Security](../security) - イメージ脆弱性(CVE)の確認
