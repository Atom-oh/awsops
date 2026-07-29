---
sidebar_position: 3
title: ECS
description: ECS クラスター、サービス、タスクの監視
---

import Screenshot from '@site/src/components/Screenshot';

# ECS (Elastic Container Service)

ECS クラスター、サービス、タスクの状態を監視できるページです。

:::info v2 での提供方法
この画面は専用ページではなく、v2 の共通インベントリグループビュー（サイドバーの「コンピュート」グループ、ECS クラスター/サービス/タスクを統合）から提供されます。
:::

<Screenshot src="/screenshots/compute/ecs.png" alt="ECS" />

## 主な機能

### 統計カード
- **Clusters**: ECS クラスターの総数(シアン)
- **Services**: サービスの総数(紫)
- **Tasks**: 実行中のタスク数(緑)
- **Container Instances**: EC2 コンテナインスタンス数(オレンジ)

### 可視化チャート
- **Running Tasks per Cluster**: クラスター別の実行中タスク数の円グラフ

### クラスターテーブル
| カラム | 説明 |
|------|------|
| Cluster Name | クラスター名 |
| Status | ステータス(ACTIVE、INACTIVE) |
| Running Tasks | 実行中のタスク数 |
| Pending Tasks | 待機中のタスク数 |
| Active Services | アクティブなサービス数 |
| Container Instances | コンテナインスタンス数 |
| Region | リージョン |

### サービステーブル
| カラム | 説明 |
|------|------|
| Service Name | サービス名 |
| Status | ステータス(ACTIVE、DRAINING) |
| Desired | 希望するタスク数 |
| Running | 実行中のタスク数 |
| Pending | 待機中のタスク数 |
| Launch Type | 起動タイプ(FARGATE、EC2) |
| Strategy | スケジューリング戦略 |

### クラスター詳細パネル
クラスターをクリックすると詳細情報を確認できます:
- **Cluster セクション**: Name、ARN、Status、Tasks、Services、Container Instances
- **Settings セクション**: クラスター設定(Container Insights など)
- **Tags セクション**: クラスターのタグ

## 使い方

1. サイドバーで **Compute > ECS** をクリックします
2. 上部の統計カードで ECS 全体の状況を把握します
3. Clusters テーブルでクラスターごとの状態を確認します
4. Services テーブルでサービスごとの Desired と Running のタスク数を比較します
5. クラスターをクリックして詳細設定を確認します

## Fargate vs EC2 Launch Type

| 区分 | Fargate | EC2 |
|------|---------|-----|
| インフラ管理 | サーバーレス(AWS 管理) | 自己管理が必要 |
| コスト | vCPU/Memory ベース | EC2 インスタンス費用 |
| スケーリング | 自動 | Auto Scaling の設定が必要 |
| コスト分析 | Container Cost ページ対応 | Phase 2 予定 |

## 利用のヒント

:::tip サービス状態の確認
Services テーブルで Running が Desired より少ない場合、タスクのデプロイに問題がある可能性があります。タスクの失敗原因を確認してください。
:::

:::tip Pending Tasks の監視
Pending Tasks が長時間続く場合、リソース不足やスケジューリングの問題が疑われます。
:::

:::info AI 分析
AI Assistant で「ECS クラスターの一覧」「Fargate サービスを見せて」「タスクのデプロイ失敗原因を分析して」などで分析できます。
:::

## 関連ページ

- [ECR](../compute/ecr) - コンテナイメージレジストリ
- [ECS Container Cost](../compute/ecs-container-cost) - ECS タスクのコスト分析
- [VPC](../network/vpc) - ECS のネットワーク構成
