# 알림 설정 / Alert Settings

## 역할 / Role
알림 웹훅 수신·상관 분석·AI 진단·Slack 알림 파이프라인 설정 페이지.
(Configures the alert webhook → correlation → AI diagnosis → Slack notification pipeline.)

## 주요 파일 / Key Files
- `page.tsx` — 웹훅 URL/시크릿 표시, 소스별 매핑, Slack 채널 라우팅, HMAC 시크릿 회전

## 연결된 라이브러리 / Backend
- `src/lib/alert-types.ts` — 이벤트 타입 + 소스별 정규화 (CloudWatch SNS · Alertmanager · Grafana · Generic)
- `src/lib/alert-correlation.ts` — 시간/서비스/리소스 기반 그룹화, 중복 제거, 심각도 에스컬레이션
- `src/lib/alert-diagnosis.ts` — Bedrock 기반 진단 오케스트레이터 (컬렉터·데이터소스 병렬 수집, 변경 감지)
- `src/lib/alert-knowledge.ts` — 진단 기록 저장, 유사도 검색, 통계
- `src/lib/slack-notification.ts` — Block Kit 메시지, 심각도 채널 라우팅, 스레드 업데이트
- API: `api/alert-webhook/route.ts` (수신), `api/notification/route.ts` (발송)

## 알림 소스 / Supported Sources
| 소스 | 파서 | 포맷 |
|------|------|------|
| CloudWatch SNS | `normalizeCloudWatchAlarm()` | SNS envelope의 `Message` JSON |
| Alertmanager | `normalizeAlertmanager()` | Prometheus Alertmanager v4 webhook |
| Grafana | `normalizeGrafana()` | Grafana Unified Alerting webhook |
| Generic | `normalizeGeneric()` | 임의 JSON (매핑 규칙 필요) |

## 규칙 / Rules
- 모든 웹훅은 HMAC-SHA256 인증 필수 — 헤더 `X-AWSops-Signature`
- 시크릿은 회전 가능 — 활성/대기 2개 보관, 양쪽 모두 유효
- 같은 리소스·동일 지표 알림은 상관 분석 윈도우(기본 5분) 내 통합
- AI 진단은 심각도 `high`/`critical`만 자동 트리거 — 비용 제어
- Slack 채널 매핑 없는 알림은 기본 채널로 폴백

---

# Alert Settings (English)

## Role
Configures the alert pipeline: webhook ingestion → correlation → AI diagnosis → Slack notification.

## Sources
CloudWatch SNS, Alertmanager, Grafana, Generic JSON — each with a normalizer in `alert-types.ts`.

## Rules
- All webhooks require HMAC-SHA256 (`X-AWSops-Signature`); secrets rotate with active+standby pair
- Same resource + same metric within correlation window (default 5 min) get deduplicated
- AI diagnosis auto-fires only on `high`/`critical` severity (cost control)
- Alerts without an explicit Slack channel mapping fall back to a default channel
