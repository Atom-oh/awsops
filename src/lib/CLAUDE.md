# 라이브러리 모듈

## 역할
핵심 라이브러리: Steampipe 데이터베이스 연결, SQL 쿼리 정의, 인벤토리, 설정 관리.

## 주요 파일
- `steampipe.ts` — pg 풀 + 배치 쿼리 + 캐시 + Cost 가용성 + buildSearchPath + runCostQueriesPerAccount
- `resource-inventory.ts` — 리소스 인벤토리 스냅샷 (data/inventory/, 계정별 디렉토리)
- `cost-snapshot.ts` — Cost 데이터 스냅샷 폴백 (data/cost/, 계정별)
- `app-config.ts` — 앱 설정 (costEnabled, agentRuntimeArn, accounts[], customerLogo, adminEmails 등)
- `cache-warmer.ts` — 백그라운드 캐시 프리워밍 (대시보드 쿼리만, 4분 주기, lazy-init, monitoring 쿼리 제외 — CloudWatch FDW가 pg Pool 고갈 유발, 멀티 어카운트 최대 3개 계정 워밍)
- `agentcore-stats.ts` — AgentCore 호출 통계 + 모델별 토큰 사용량 추적 (data/agentcore-stats.json)
- `agentcore-memory.ts` — 대화 이력 저장/검색, 사용자별 분리 (data/memory/)
- `auth-utils.ts` — Cognito JWT에서 사용자 정보 추출 (Lambda@Edge 검증 후 payload 디코딩)
- `eks-optimize-queries.ts` — EKS 리소스 최적화 (Prometheus 메트릭 디스커버리 + K8s 리소스 수집 + 비용 분석 프롬프트)
- `report-pptx.ts` — PPTX 리포트 생성 (WADD 스타일: 타이틀바, 요약바, 2컬럼/카드 레이아웃, 인라인 테이블, 마크다운 파싱)
- `report-docx.ts` — DOCX 리포트 생성 (docx 패키지, A4/라이트 테마, TOC, 마크다운→문단/테이블/블릿 변환, 헤더/푸터/페이지 번호)
- `report-scheduler.ts` — 리포트 스케줄러 (주기적 자동 진단, weekly/biweekly/monthly, KST 기준, data/report-schedule.json)
- `alert-types.ts` — 알림 이벤트 타입 + 소스별 정규화 (CloudWatch SNS, Alertmanager, Grafana, Generic)
- `alert-correlation.ts` — 알림 상관 분석 엔진 (시간/서비스/리소스 매칭, 중복 제거, 심각도 에스컬레이션, 30초 버퍼링)
- `alert-diagnosis.ts` — 알림 진단 오케스트레이터 (전략 선택, 컬렉터/데이터소스 병렬 실행, 변경 감지, Bedrock Opus 분석)
- `alert-knowledge.ts` — 알림 지식 베이스 (진단 기록 저장 data/alert-diagnosis/, 유사도 검색, 통계)
- `slack-notification.ts` — Slack 알림 (Block Kit, Bot Token/Webhook, 채널 라우팅, 스레드 업데이트)
- `sns-notification.ts` — SNS 이메일 알림 (마크다운 → 평문 변환, 구독자 라우팅)
- `alert-sqs-poller.ts` — SQS 백그라운드 폴러 (SNS→SQS→EC2 전달 경로, DLQ 처리, Rate 제한)
- `datasource-client.ts` — 외부 데이터소스 HTTP 클라이언트 (7종, SSRF 방지, IPv4/IPv6 private CIDR 차단, redirect 0)
- `datasource-registry.ts` — 데이터소스 타입 레지스트리 (헬스체크 엔드포인트, 쿼리 언어 메타데이터)
- `datasource-prompts.ts` — 데이터소스별 자연어→쿼리 생성 프롬프트
- `report-generator.ts` — 종합 진단 데이터 수집 오케스트레이터 (Steampipe + CloudWatch + 데이터소스)
- `report-prompts.ts` — 15섹션 진단 프롬프트 정의
- `report-pdf.ts` — Puppeteer 기반 PDF 리포트 (헤드리스 브라우저 print)
- `queries/*.ts` — 25개 SQL 쿼리 파일 (ebs, msk, opensearch, container-cost, eks-container-cost, bedrock 포함)
- `collectors/*.ts` — 자동 수집 에이전트 (ADR-009): incident · eks-optimize · db-optimize · msk-optimize · network-flow · trace-analyze · idle-scan (상세: `collectors/CLAUDE.md`)

## 규칙
- 모든 DB 접근은 `steampipe.ts`의 `runQuery()` 또는 `batchQuery()`를 통해 수행 (pg Pool `max: 10`, `BATCH_SIZE: 8`, statement_timeout 120s, node-cache TTL 300s)
- Steampipe CLI 사용 금지 — pg Pool이 660배 빠름
- Steampipe는 `--database-listen network`으로 실행 (VPC Lambda :9193 접근)
- 쿼리 작성 전 `information_schema.columns`로 컬럼명 확인
- JSONB 중첩 주의: MSK `provisioned`, OpenSearch `encryption_at_rest_options`, ElastiCache `cache_nodes`
- SQL에서 `$` 사용 금지
- 목록 쿼리에서 SCP 차단 컬럼 사용 금지

---

# Lib Module (English)

## Role
Core libraries: Steampipe database connection, SQL query definitions, inventory, config management.

## Key Files
- `steampipe.ts` — pg Pool + batchQuery + cache + Cost probe + buildSearchPath + runCostQueriesPerAccount
- `resource-inventory.ts` — Resource inventory snapshots (data/inventory/, per-account directories)
- `cost-snapshot.ts` — Cost data snapshot fallback (data/cost/, per-account)
- `app-config.ts` — App config (costEnabled, agentRuntimeArn, accounts[], customerLogo, adminEmails, etc.)
- `cache-warmer.ts` — Background cache pre-warming (dashboard queries only, 4-min interval, lazy-init; monitoring queries excluded — CloudWatch FDW exhausts pg Pool; multi-account caps at 3 account variants)
- `agentcore-stats.ts` — AgentCore call stats + per-model token usage tracking (data/agentcore-stats.json)
- `agentcore-memory.ts` — Conversation history save/search, per-user isolation (data/memory/)
- `auth-utils.ts` — Extract Cognito user from JWT (payload decode after Lambda@Edge verification)
- `eks-optimize-queries.ts` — EKS resource optimization (Prometheus metric discovery + K8s resource collection + cost analysis prompt)
- `report-pptx.ts` — PPTX report generation (WADD-style: title bars, summary bars, 2-column/card layouts, inline tables, markdown parsing)
- `report-docx.ts` — DOCX report generation (docx package, A4/light theme, TOC, markdown→paragraph/table/bullet conversion, header/footer/page numbers)
- `report-scheduler.ts` — Report scheduler (periodic auto-diagnosis, weekly/biweekly/monthly, KST-based, data/report-schedule.json)
- `alert-types.ts` — Alert event types + per-source normalizers (CloudWatch SNS, Alertmanager, Grafana, Generic)
- `alert-correlation.ts` — Alert correlation engine (time/service/resource matching, dedup, severity escalation, 30s buffering)
- `alert-diagnosis.ts` — Alert diagnosis orchestrator (strategy selection, parallel collectors/datasources, change detection, Bedrock Opus analysis)
- `alert-knowledge.ts` — Alert knowledge base (diagnosis record storage data/alert-diagnosis/, similarity search, statistics)
- `slack-notification.ts` — Slack notification client (Block Kit, Bot Token/Webhook, severity channel routing, thread updates)
- `sns-notification.ts` — SNS email notifications (markdown-to-plaintext conversion, subscriber routing)
- `alert-sqs-poller.ts` — SQS background poller (SNS→SQS→EC2 path, DLQ handling, rate limiting)
- `datasource-client.ts` — External datasource HTTP client (7 platforms, SSRF protection, IPv4/IPv6 private-CIDR block, zero redirects)
- `datasource-registry.ts` — Datasource type registry (health endpoints, query language metadata)
- `datasource-prompts.ts` — Natural-language → query generation prompts per datasource type
- `report-generator.ts` — Diagnosis data collection orchestrator (Steampipe + CloudWatch + datasources)
- `report-prompts.ts` — 15-section diagnosis prompt definitions
- `report-pdf.ts` — Puppeteer-based PDF report (headless browser print)
- `queries/*.ts` — 25 SQL query files (incl. ebs, msk, opensearch, container-cost, eks-container-cost, bedrock)
- `collectors/*.ts` — Auto-collect agents (ADR-009): incident · eks-optimize · db-optimize · msk-optimize · network-flow · trace-analyze · idle-scan (see `collectors/CLAUDE.md`)

## Rules
- ALL database access through `runQuery()` or `batchQuery()` in steampipe.ts (pg Pool `max: 10`, `BATCH_SIZE: 8`, 120s statement timeout, 300s node-cache TTL)
- Never use Steampipe CLI — pg Pool is 660x faster
- Steampipe runs with `--database-listen network` (VPC Lambda access on :9193)
- Verify column names via `information_schema.columns` before writing queries
- Watch JSONB nesting: MSK `provisioned`, OpenSearch `encryption_at_rest_options`, ElastiCache `cache_nodes`
- No `$` in SQL. Avoid SCP-blocked columns in list queries.
