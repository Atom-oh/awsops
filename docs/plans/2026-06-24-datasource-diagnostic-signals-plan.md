# Datasource Diagnostic Signals — 구현 계획 (Implementation Plan)

> Source spec: `docs/specs/2026-06-24-datasource-diagnostic-signals-design.md`
> 브랜치: `feat/v2-datasource-diag-signals` · base: `origin/feat/v2-architecture-design`
> 방식: TDD (test-first) + Tidy-First (구조/동작 분리), 태스크당 1 커밋.
> 게이트: 전부 `datasource_diagnosis_enabled` 하 — 기본 OFF면 $0/무변경.

### Task 1: DB migration — datasource_diag_signals 테이블 (구조)

**Files:**
- Create: `terraform/v2/foundation/migrations/01KW000DSDIAGSIGNALS01_datasource_diag_signals.sql`

- [ ] spec §4 테이블(`datasource_diag_signals`) + `dds_instance_idx` 인덱스를 `CREATE TABLE IF NOT EXISTS`(멱등)로 작성.
- [ ] 기존 `migrations/` 명명/형식과 일치(ULID 접두 + `_snake.sql`); 헤더 주석으로 목적/ADR-007 read-only 명시.
- [ ] DB 적용은 배포 단계 `migrate.mjs` 담당(여기선 파일만).

### Task 2: 진단 신호 카탈로그 + 순수 빌드 (TDD)

**Files:**
- Create: `scripts/v2/workers/diagnosis/signal_catalog.py`
- Test: `scripts/v2/workers/diagnosis/test_signal_catalog.py`

- [ ] **test-first**: 전 메트릭 존재 스키마 → 8 신호 `ready` + PromQL + `meta.threshold`; 일부 부재 → `unavailable` + `missing_metrics` 정확; 빈 스키마 → 전부 unavailable, never raise.
- [ ] `CATALOG`(spec §5 8 신호) + 순수 `build_signals(schema) -> rows`. 메트릭명은 상수(스키마는 존재성만 검증, 주입 없음).
- [ ] `python3 -m pytest scripts/v2/workers/diagnosis/test_signal_catalog.py` GREEN.

### Task 3: DB helpers — diag_signals upsert/read/sweep (TDD)

**Files:**
- Modify: `scripts/v2/workers/db.py`
- Test: `scripts/v2/workers/test_datasource_index.py`

- [ ] **test-first**: `upsert_diag_signals` / `read_signal_schema_version` / mark-sweep 가 바인드 파라미터 사용 + 멱등(주입된 fake conn).
- [ ] `db.py`에 헬퍼 추가(기존 conn/Data API 패턴 일치).
- [ ] 테스트 GREEN.

### Task 4: datasource_index 잡 핸들러 — 스키마-해시 재빌드 (TDD)

**Files:**
- Create: `scripts/v2/workers/datasource_index.py`
- Modify: `scripts/v2/workers/handlers.py`
- Test: `scripts/v2/workers/test_datasource_index.py`

- [ ] **test-first**: connector+DB 주입 → introspect 해시 동일=재빌드 스킵; 변경=build_signals→upsert+sweep; connector 실패/빈 스키마=never raise·기존 보존.
- [ ] `datasource_index.py`: `run(payload, conn)` — instance introspect(기존 connector invoke 재사용)→hash→compare→(변경시) build_signals→upsert/sweep. bounded·idempotent·never-raise.
- [ ] `handlers.py`: `_datasource_index` 래퍼 + `REGISTRY["datasource_index"] = (_datasource_index, "lambda")`.
- [ ] 테스트 GREEN.

### Task 5: collect_datasources 개편 — 저장 신호 실행 (TDD)

**Files:**
- Modify: `scripts/v2/workers/diagnosis/sources.py`
- Test: `scripts/v2/workers/diagnosis/test_datasources.py`
- Test: `scripts/v2/workers/diagnosis/test_sources.py`

- [ ] **test-first**: ready 행 주입 → 저장 query 실행·PII 미반출·`meta.threshold` 플래그; 게이트 OFF → "비활성" note; ready 없음 → "연결/신호 없음"; unavailable → 사유 note.
- [ ] `collect_datasources`가 제네릭 `_plan_queries` 대신 `datasource_diag_signals`(status=ready) 읽어 실행. fan-out·deadline·byte-cap·redaction 재사용. 구식 `_plan_queries` 제거/deprecate.
- [ ] 테스트 GREEN.

### Task 6: 리포트 통합 + 활용 여부 (TDD)

**Files:**
- Modify: `scripts/v2/workers/diagnosis/sections.py`
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- Test: `scripts/v2/workers/diagnosis/test_sections_wadd.py`

- [ ] **test-first**: `_coverage_note`가 `datasources_obs`에 4상태 문구(사용 N/비활성/연결없음/unavailable metric X) 출력; 신규 섹션 `external_obs_signals`(sources=["datasources_obs"]) 존재 + 데이터 없을 때 "데이터 불가".
- [ ] `sections.py`: `external_obs_signals` 섹션 추가. `report.py`: `_coverage_note` 개선(empty 분기에서도 notes 출력·datasource 활용여부 명시).
- [ ] 테스트 GREEN.

### Task 7: Terraform — 일일 스케줄 + 잡 런타임 (구조, 게이트)

**Files:**
- Modify: `terraform/v2/foundation/workers.tf`

- [ ] `datasource_index` 일일 EventBridge 규칙 + 타겟(enabled instance 전수 enqueue). 전부 `datasource_diagnosis_enabled && workers_enabled` 게이트(count). 기존 connector invoke IAM 재사용.
- [ ] `terraform -chdir=terraform/v2/foundation validate` 통과; 게이트 OFF → `plan` no-op(apply는 컨트롤러).

### Task 8: BFF — diag-signals 읽기 라우트 (TDD)

**Files:**
- Create: `web/lib/diag-signals.ts`
- Create: `web/app/api/datasources/[id]/diag-signals/route.ts`
- Test: `web/lib/diag-signals.test.ts`
- Test: `web/app/api/datasources/[id]/diag-signals/route.test.ts`

- [ ] **test-first**: 인증 필요; ready/unavailable 분리 JSON; egress 없음(DB read만).
- [ ] `diag-signals.ts`(쿼리) + `route.ts`(GET, verifyUser, getPool).
- [ ] 관련 `npm test` GREEN.

### Task 9: BFF — datasource 추가/refresh 시 index 잡 enqueue (TDD)

**Files:**
- Modify: `web/lib/diag-signals.ts`
- Test: `web/lib/diag-signals.test.ts`

- [ ] **test-first**: 추가/refresh 시 `datasource_index` job enqueue 헬퍼(기존 enqueueJob 재사용) 호출 검증.
- [ ] enqueue 헬퍼를 `diag-signals.ts`에 추가하고 datasource add/refresh 경로에서 호출(해당 라우트 수정 시 스코프에 추가).
- [ ] 테스트 GREEN.

### Task 10: Explore — quick-query 칩 컴포넌트 (TDD)

**Files:**
- Create: `web/app/datasources/DiagSignalChips.tsx`
- Test: `web/app/datasources/DiagSignalChips.test.tsx`

- [ ] **test-first**: ready=클릭가능 칩(클릭→쿼리 채움/실행 콜백), unavailable=비활성+툴팁("metric X 없음 — Refresh schema").
- [ ] `DiagSignalChips.tsx` + Explore 페이지 마운트(실행 콜백 연결). Integration 페이지엔 추가 안 함.
- [ ] 관련 `npm test` GREEN.

## 검증 (전체)
- Python: `python3 -m pytest scripts/v2/workers/` GREEN.
- Web: 관련 `npm test` GREEN; `next build` 타입 통과(*.test.ts 타입잡음 비차단).
- Terraform: `validate` 통과; 게이트 OFF → `plan` no-op.

## 배포 (구현 후, 별도)
- `migrate.mjs`(신규 테이블) → targeted terraform apply(게이트 ON 시) → `make workers`(arm64) → `make deploy`(web). 전부 게이트 하: 기본 OFF면 비용/변경 0.
