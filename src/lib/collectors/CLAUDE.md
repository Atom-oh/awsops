# Collectors 모듈

## 역할
AI 진단/최적화용 auto-collect 에이전트. 각 collector가 Steampipe·CloudWatch·외부 데이터소스에서 데이터를 병렬 수집하고 Bedrock 분석용 컨텍스트 문자열로 포맷.

## 주요 파일
- `types.ts` — 공통 인터페이스: `Collector { collect(send, accountId?, isEn?), ... }`, `CollectorResult { sections, usedTools, queriedResources, viaSummary }`, `SendFn(event, data)` (SSE 진행 이벤트)
- `db-optimize.ts` — RDS/DynamoDB/ElastiCache 최적화 데이터 수집
- `eks-optimize.ts` — EKS 리소스 최적화 (Prometheus 메트릭 + K8s 리소스)
- `msk-optimize.ts` — MSK 클러스터 최적화 데이터 수집
- `idle-scan.ts` — 유휴 리소스 스캔 (비용 절감 후보)
- `incident.ts` — 장애 분석용 데이터 수집 (이벤트, 로그, 메트릭)
- `trace-analyze.ts` — 트레이스 분석 (외부 데이터소스 Tempo/Jaeger 연동)

## 규칙
- 모든 collector는 `types.ts`의 `Collector` 인터페이스 구현
- 수집 진행 상황은 `send(event, data)`로 SSE 스트리밍 — UI 진행 표시에 사용
- DB 접근은 `steampipe.ts`의 `runQuery()`/`batchQuery()` 경유 (직접 pg 연결 금지)
- 다국어: `isEn` 플래그로 한/영 컨텍스트 생성

---

# Collectors Module (English)

## Role
Auto-collect agents for AI diagnosis/optimization. Each collector gathers data in parallel from Steampipe, CloudWatch, and external datasources, then formats it as a context string for Bedrock analysis.

## Key Files
- `types.ts` — Shared interfaces: `Collector { collect(send, accountId?, isEn?), ... }`, `CollectorResult { sections, usedTools, queriedResources, viaSummary }`, `SendFn(event, data)` (SSE progress events)
- `db-optimize.ts` — RDS/DynamoDB/ElastiCache optimization data collection
- `eks-optimize.ts` — EKS resource optimization (Prometheus metrics + K8s resources)
- `msk-optimize.ts` — MSK cluster optimization data collection
- `idle-scan.ts` — Idle resource scan (cost-saving candidates)
- `incident.ts` — Incident analysis data collection (events, logs, metrics)
- `trace-analyze.ts` — Trace analysis (external datasource Tempo/Jaeger integration)

## Rules
- Every collector implements the `Collector` interface from `types.ts`
- Stream collection progress via `send(event, data)` (SSE) — used for UI progress display
- All DB access through `runQuery()`/`batchQuery()` in steampipe.ts (no direct pg connections)
- i18n: generate Korean/English context via the `isEn` flag
