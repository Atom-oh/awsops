---
sidebar_position: 8
title: AI 종합 진단
description: 15섹션 Bedrock Opus 진단 리포트, DOCX/MD/PDF 내보내기, 자동 스케줄링
---

# AI 종합 진단

AWSops 전체 인프라에 대한 **15섹션 AI 진단 리포트**를 자동으로 생성하고, DOCX / Markdown / PDF 형식으로 내보낼 수 있는 페이지입니다 (`/ai-diagnosis`).

## 개요

Amazon Bedrock Claude Opus 모델이 Steampipe 인벤토리, CloudWatch 메트릭, Cost Explorer, Compliance 결과 등을 종합 분석하여 하나의 리포트로 엮어줍니다. 월간 운영 보고, 분기별 아키텍처 리뷰, 감사 대응 용도로 사용합니다.

| 항목 | 값 |
|------|---|
| **모델** | `global.anthropic.claude-sonnet-4-6` (기본), Opus 선택 가능 |
| **섹션 수** | 15 (Executive Summary → Action Plan) |
| **출력 포맷** | DOCX (A4, TOC), Markdown, PDF, PPTX |
| **저장 위치** | S3 리포트 버킷 + 메타는 `data/reports/*.json` |
| **스케줄** | 없음 / 주간 / 격주 / 월간 |

## 15개 섹션

| # | 섹션 | 데이터 소스 |
|---|------|-----------|
| 1 | Executive Summary | 전 섹션 요약 |
| 2 | 리소스 인벤토리 | `data/inventory/*.json` |
| 3 | Compute (EC2/Lambda/ECS/EKS) | Steampipe + CloudWatch |
| 4 | Storage & DB (S3/EBS/RDS/DDB) | Steampipe + CW |
| 5 | Network & CDN (VPC/CloudFront/WAF) | Steampipe |
| 6 | Security (IAM/Public/Open SG) | Steampipe + Compliance |
| 7 | Compliance (CIS Benchmark) | Powerpipe 결과 |
| 8 | Cost 분석 | Cost Explorer + 스냅샷 |
| 9 | 리소스 증감 추이 | Resource Inventory |
| 10 | 성능 이상 징후 | CloudWatch 메트릭 |
| 11 | 장애 이력 & 알림 상관 | Alert Knowledge Base |
| 12 | 외부 데이터소스 요약 | Prometheus/Loki 등 |
| 13 | AI 대화 활용도 | AgentCore Memory 통계 |
| 14 | 주요 리스크 & 권장 조치 | AI 종합 |
| 15 | Action Plan (30/60/90일) | AI 종합 |

## 리포트 생성

### 수동 실행

1. 사이드바 **AI Diagnosis** 클릭
2. **Run Diagnosis** 버튼 클릭
3. 진행률 표시기로 섹션별 수집 상태 확인 (평균 3~6분)
4. 완료되면 리포트 카드가 목록 상단에 추가됨

:::tip 소요 시간
Opus 모델 + 15섹션 기준 평균 4~6분. 계정 수가 많거나 Cost API 지연이 있으면 최대 10분까지 걸릴 수 있습니다.
:::

### 자동 스케줄링

| 주기 | 실행 시점 |
|------|----------|
| `weekly` | 매주 월요일 오전 9시 (KST) |
| `biweekly` | 격주 월요일 오전 9시 |
| `monthly` | 매월 1일 오전 9시 |
| `none` | 비활성화 |

`data/config.json`의 `reportSchedule` 필드로 설정하거나, UI 상단의 **Schedule** 드롭다운으로 변경합니다.

## 내보내기

생성된 리포트는 4가지 포맷으로 다운로드할 수 있습니다:

| 포맷 | 용도 | 특징 |
|------|------|------|
| **DOCX** | 보고서 제출 | A4, TOC 자동 생성, 표/차트 포함 |
| **Markdown** | GitHub/Notion 첨부 | 원본 텍스트, 이미지 링크 포함 |
| **PDF** | 인쇄/이메일 | DOCX 변환, 폰트 임베디드 |
| **PPTX** | 경영진 브리핑 | WADD 스타일, 섹션당 1~2 슬라이드 |

:::info 리포트 프록시 다운로드
브라우저에서 직접 S3 URL에 접근하는 대신, Next.js API가 사전 서명된 URL을 생성해 프록시합니다. 자격 증명 노출 없이 대용량(100MB+) 파일 다운로드가 가능합니다 (ADR-014).
:::

## 알림 연동

진단 완료 시 다음 채널로 알림을 보냅니다:

- **Slack**: Block Kit 카드 (리스크 수, 심각도, 다운로드 링크)
- **이메일**: `adminEmails`에 등록된 사용자 대상 요약 + PDF 첨부

알림 구성은 `data/config.json`의 `notificationChannels`에서 관리합니다.

## 알림 파이프라인과의 연계

실시간 알림(CloudWatch/Alertmanager/Grafana)이 심각도 `critical`로 집계되면, AWSops가 자동으로 **Alert-Triggered Diagnosis** 모드로 부분 진단을 실행합니다:

- 영향받은 서비스/리소스/네임스페이스로 스코프 제한
- 3~5개 관련 섹션만 재생성 (1~2분 소요)
- 결과를 알림 스레드(Slack)에 reply로 첨부

자세한 내용은 [알림 파이프라인](./alerts.md) 문서를 참고하세요.

## 사용 팁

### 비용 제어
Opus는 Sonnet 대비 약 5배 비싸므로, 매주 실행 대신 **월간 Opus + 주간 Sonnet** 조합을 권장합니다. UI에서 모델을 선택할 수 있습니다.

### 섹션 선택 실행
전체 15섹션 대신 일부만 실행하려면 API를 직접 호출하세요:
```bash
curl -X POST /awsops/api/report \
  -H 'Content-Type: application/json' \
  -d '{"sections": ["cost", "compliance"], "model": "sonnet"}'
```

### 리포트 재생성
기존 리포트를 참고하여 차이점만 분석하려면 **Compare with previous** 토글을 켜세요. 이전 리포트 데이터와 diff를 제공합니다.

## 관련 페이지

- [알림 파이프라인](./alerts.md) — 알림 트리거 부분 진단
- [Resource Inventory](./inventory.md) — 진단 섹션 2 데이터 원본
- [Compliance](../security/compliance) — 진단 섹션 7 원본
- [Cost Explorer](./cost) — 진단 섹션 8 원본

## 참고

- ADR-019: 진단 리포트 포맷 매트릭스
- ADR-014: 리포트 프록시 다운로드 URL
- ADR-016: Bedrock 모델 선택 전략
