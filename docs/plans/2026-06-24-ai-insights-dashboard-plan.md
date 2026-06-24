# AI Insights Dashboard — 구현 계획 (Implementation Plan)

> Source spec: `docs/specs/2026-06-24-ai-insights-dashboard-design.md`
> 브랜치: `feat/v2-ai-insights` · base: `origin/feat/v2-architecture-design`
> 방식: TDD (test-first) + Tidy-First, 태스크당 1 커밋. 게이트: `ai_insights_enabled`(신규, 기본 false→$0).
> 패턴: k8s API = `agent/lambda/istio_read_mcp.py`의 presigned-STS `k8s-aws-v1.` 토큰; CE = `diagnosis/sources.py` get_cost_and_usage; dispatcher/worker = `schedule_dispatcher`/`handlers.REGISTRY`.

## 의존 순서
1(mig) → 2/3/4(수집기, 독립) → 5(종합) → 6(db) → 7(잡/핸들러, needs 5·6) → 8(dispatcher) → 9(terraform, needs var) → 10(BFF) → 11(카드).

### Task 1: DB migration — ai_insights (구조)

**Files:**
- Create: `terraform/v2/foundation/migrations/01KVWHA8699729P4J39XJNDB6M_ai_insights.sql`

- [ ] spec §4 테이블 `CREATE TABLE IF NOT EXISTS ai_insights` (bigserial id, account_id, status CHECK in succeeded/partial/failed, insights jsonb, sources_used jsonb, model, error, generated_at) + `ai_insights_latest_idx (account_id, generated_at DESC)`. 멱등. 헤더 주석: read-only·ADR-007.
- [ ] ULID 파일명 형식 + 기존 migrations와 정합(grep). 실제 ULID로 교체.

### Task 2: cost anomaly collector (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/__init__.py`
- Create: `scripts/v2/workers/insight/cost_anomalies.py`
- Create: `scripts/v2/workers/insight/test_cost_anomalies.py`

- [ ] **test-first**: 일별·서비스별 day-over-day 급증(임계 % + 절대액) 탐지; 정상=빈 items; CE 에러=never-raise(notes); 비민감 집계값만(PII 없음).
- [ ] `collect_cost_anomalies(ce=None)` — `ce.get_cost_and_usage`(GroupBy SERVICE, 최근 N일) → 서비스별 전일 대비 급증 item `{severity,title,detail,refs}`. ce 주입 가능.
- [ ] `python3 -m pytest scripts/v2/workers/insight/test_cost_anomalies.py` GREEN.

### Task 3: CloudWatch anomaly collector (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/cw_anomalies.py`
- Create: `scripts/v2/workers/insight/test_cw_anomalies.py`

- [ ] **test-first**: `DescribeAlarms(StateValue=ALARM)` → item per ALARM(알람명·네임스페이스·차원만, 값 redaction); 알람 없음=빈; 에러=never-raise. 페이지네이션 bounded.
- [ ] `collect_cw_anomalies(cw=None)` — ALARM 상태 알람 수집(MetricAlarms + CompositeAlarms). cw 주입.
- [ ] GREEN.

### Task 4: K8s events collector (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/k8s_events.py`
- Create: `scripts/v2/workers/insight/test_k8s_events.py`

- [ ] **test-first**: parse/aggregate — Warning 이벤트 리스트(`/api/v1/events`)에서 주목 reason(OOMKilling/OOMKilled·FailedScheduling·BackOff·CrashLoopBackOff·Failed·Unhealthy·FailedMount·Evicted·NodeNotReady) 필터 + reason×involvedObject 집계 → items; message redaction(PII 방어); 시간창·건수 bounded; HTTP/토큰 에러=graceful skip(notes, never-raise).
- [ ] `collect_k8s_events(clusters=None, getter=None)` — 클러스터 목록(env `ONBOARD_EKS_CLUSTERS` 콤마분리)별 `_k8s_session`(presigned-STS, istio_read_mcp 패턴 복제) + `_k8s_get('/api/v1/events')`. `getter` 주입 가능(테스트는 raw event JSON fixture로 순수 parse 검증). access-entry 미등록/HTTP 4xx=skip.
- [ ] GREEN.

### Task 5: insight synthesis + deterministic fallback (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/generate.py`
- Create: `scripts/v2/workers/insight/test_generate.py`

- [ ] **test-first**: bedrock 정상→파싱된 3~5 불릿(severity/title/detail/source); bedrock 실패/빈→**결정론 폴백**(수집 신호 severity 상위 N 불릿, status partial); 신호 없음→"특이사항 없음"; 불릿 수/길이 캡; PII 없음.
- [ ] `synthesize(signals, invoke=None)` — 신호 요약을 Bedrock(기본 Haiku) 1회 호출, JSON 마커 파싱, 실패 시 `_fallback(signals)`. invoke 주입.
- [ ] GREEN.

### Task 6: DB helpers — ai_insights (TDD)

**Files:**
- Modify: `scripts/v2/workers/db.py`
- Create: `scripts/v2/workers/insight/test_insight_db.py`

- [ ] **test-first**: `insert_insight(conn, status, insights, sources_used, model, error)` 바인드+::jsonb; `get_latest_insight(conn)` → 최신 행 파싱. 멱등/파라미터화.
- [ ] `db.py`에 두 헬퍼 추가.
- [ ] GREEN.

### Task 7: insight worker job + handler (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/job.py`
- Modify: `scripts/v2/workers/handlers.py`
- Create: `scripts/v2/workers/insight/test_job.py`

- [ ] **test-first**: `run(payload, conn)` — collect_all(주입된 수집기 stub)→synthesize(stub)→`insert_insight`; 일부 수집기 실패해도 진행(부분), 전부 실패=status failed; never-raise. handler `_insight(payload, dry_run)` connect/close.
- [ ] `job.py run()` + `handlers.py` `_insight` + `REGISTRY["insight"]=(_insight,"lambda")`.
- [ ] GREEN.

### Task 8: insight_dispatcher (TDD)

**Files:**
- Create: `scripts/v2/workers/insight_dispatcher.py`
- Create: `scripts/v2/workers/test_insight_dispatcher.py`

- [ ] **test-first**: `lambda_handler`가 `insight` 잡 1건 enqueue(db.insert_job + SQS, schedule_dispatcher 패턴); QUEUE_URL 미설정=fail-loud; SQS 실패 시 orphan ledger row 정리.
- [ ] 구현.
- [ ] GREEN.

### Task 9: Terraform — var/gate + dispatcher + IAM + bundle (구조, 게이트)

**Files:**
- Modify: `terraform/v2/foundation/variables.tf`
- Modify: `terraform/v2/foundation/workers.tf`

- [ ] `variables.tf`: `variable "ai_insights_enabled"`(bool, default false, 설명 "OFF→$0", workers_enabled 동반 validation — 기존 패턴 참고).
- [ ] `workers.tf`: `local.aii = var.workers_enabled && var.ai_insights_enabled ? 1 : 0`; insight_dispatcher lambda + `aws_cloudwatch_event_rule`(rate(6 hours)) + target + permission; worker role IAM 추가(`cloudwatch:DescribeAlarms`,`cloudwatch:GetMetricData`,`ce:GetCostAndUsage`); `workers_src` 아카이브에 insight/*.py(flatten) + insight_dispatcher.py 추가; 전부 `local.aii` 게이트. (EKS 이벤트 access-entry는 out-of-band 운영 — terraform 아님; 주석 명시.)
- [ ] `terraform -chdir=terraform/v2/foundation validate`; 게이트 OFF→`plan` no-op(apply는 컨트롤러).

### Task 10: BFF — /api/insights (read + refresh) (TDD)

**Files:**
- Create: `web/lib/insights.ts`
- Create: `web/app/api/insights/route.ts`
- Create: `web/app/api/insights/refresh/route.ts`
- Create: `web/lib/insights.test.ts`
- Create: `web/app/api/insights/route.test.ts`

- [ ] **test-first**: `GET /api/insights`(auth) → 최신 행; `POST /api/insights/refresh`(admin) → enqueue, 최근 running 잡 있으면 202 재사용; DB read만(egress 없음).
- [ ] `insights.ts`(getLatestInsight + enqueueInsightRefresh) + 두 route.
- [ ] 관련 `npm test` GREEN.

### Task 11: Dashboard AI Insight card (TDD)

**Files:**
- Create: `web/components/insights/InsightCard.tsx`
- Modify: `web/app/page.tsx`
- Create: `web/components/insights/InsightCard.test.tsx`

- [ ] **test-first**: severity 뱃지(critical/warning/info) 렌더; 빈 상태 CTA; 새로고침 버튼(admin)→POST; generated_at 상대시각.
- [ ] `InsightCard.tsx`(fetch /api/insights, 새로고침) + Overview(`page.tsx`) 상단 마운트.
- [ ] 관련 `npm test` GREEN.

## 검증 (전체)
- Python: `python3 -m pytest scripts/v2/workers/` GREEN.
- Web: 관련 `npm test` GREEN; `next build` 타입 통과(*.test.ts 비차단).
- Terraform: `validate` 통과; 게이트 OFF → `plan` no-op.

## 배포 (구현 후, 게이트 ON 시)
- ULID 마이그레이션 → `ai_insights_enabled=true`(+EKS 이벤트 원하면 워커 role EKS Access Entry out-of-band 등록) → targeted apply → `make workers` → `make deploy`. 기본 OFF면 $0.
