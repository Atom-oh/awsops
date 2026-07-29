---
sidebar_position: 1
title: EC2 インスタンス
description: EC2 インスタンスの一覧、ステータス監視、詳細情報の確認
---

import Screenshot from '@site/src/components/Screenshot';

# EC2 インスタンス

EC2 インスタンスのリアルタイムステータスを監視し、詳細情報を確認できるページです。

:::info v2 での提供方法
この画面は専用ページではなく、v2 の共通インベントリビュー（`/inventory/ec2`、サイドバーの「コンピュート」グループ）から提供されます。
:::

<Screenshot src="/screenshots/compute/ec2.png" alt="EC2 インスタンス" />

## 主な機能

### 統計カード
ページ上部に 4 つの StatsCard が主要指標を表示します:
- **Running**: 実行中のインスタンス数(緑)
- **Stopped**: 停止中のインスタンス数(赤)
- **Total vCPUs**: 全体の vCPU 合計(シアン)
- **Instance Types**: 使用中のインスタンスタイプの種類数(紫)

### 可視化チャート
- **Instance Type Distribution**: インスタンスタイプ別の分布を円グラフで表示
- **Instance Status**: ステータス別のインスタンス数を棒グラフで表示

### インスタンス一覧テーブル
すべての EC2 インスタンスをテーブル形式で表示します:
- Instance ID、Name、Type、State、Public/Private IP、VPC、Launch Time
- ステータスに応じて色が異なる StatusBadge を表示(running=緑、stopped=赤)

### フィルターと検索
- **検索ボックス**: ID、Name、IP など、すべてのフィールドを対象にテキスト検索
- **State フィルター**: running、stopped などステータス別のフィルタリング
- **Type フィルター**: t3.micro、m5.large などインスタンスタイプ別のフィルタリング
- **VPC フィルター**: VPC ID 別のフィルタリング
- **Clear all**: すべてのフィルターをリセット

### 詳細パネル
テーブルでインスタンスの行をクリックすると、右側に詳細パネルが開きます:
- **Instance セクション**: Instance ID、AMI、Architecture、Platform、Key Pair、IAM Role など
- **Compute セクション**: vCPUs、Cores、Threads/Core、Memory、Network Performance
- **Network セクション**: VPC、Subnet、AZ、Private/Public IP、DNS、Network Interfaces
- **Security Groups セクション**: 関連付けられたセキュリティグループの一覧
- **Storage セクション**: Root Device、Block Device Mappings
- **Tags セクション**: インスタンスに設定されたタグの一覧

## 使い方

1. サイドバーで **Compute > EC2** をクリックします
2. 上部の統計カードで全体の状況を把握します
3. フィルターを使って目的のインスタンスを探します
4. テーブルでインスタンスをクリックして詳細情報を確認します
5. 更新ボタンで最新データを読み込むことができます

## 利用のヒント

:::tip クイック検索
検索ボックスに IP アドレスの一部を入力するだけで、該当インスタンスをすばやく見つけられます。
:::

:::tip フィルターの組み合わせ
複数のフィルターを同時に使うと、より正確にインスタンスを絞り込めます。たとえば「running 状態の t3.large インスタンス」だけを表示できます。
:::

:::info AI 分析
AI Assistant で「EC2 インスタンスの一覧を見せて」「running 状態のインスタンスはいくつ?」などの質問で分析できます。
:::

## 関連ページ

- [VPC](../network/vpc) - ネットワーク構成の確認
- [EBS](../storage/ebs) - アタッチされたボリュームの確認
- [Monitoring](../monitoring) - CPU/メモリメトリクスの確認
