# ADR-018: LLM 쿼리 생성 (읽기 전용) / LLM Query Generation (read-only)

## Status / 상태
**Accepted — 두 경로 모두 GATED, 기본 false: `graph_querygen_enabled`, `diag_signal_querygen_enabled`.**

이 ADR은 새 권한이나 새 substrate를 만들지 않는다. 이미 존재하는 두 폴백 경로(그래프 쿼리 1건 · Explore
diag-signal 칩 1건)가 **공통으로 무엇에 동의하는지**를 한곳에 적어, 리뷰어가 "이건 어느 결정에 속하는가"를
BASELINE 행의 각주로 추론하지 않게 한다. PR #205 리뷰가 지적한 귀속 공백(ADR-007은 external-data
collector/SSRF 거버넌스이고 §A의 어느 항목도 다루지 않는다)을 닫는 것이 이 문서의 존재 이유다.

## Context / 컨텍스트

결정론적 카탈로그는 이름을 미리 알고 있는 스키마에만 매칭된다. K8s가 아닌 Prometheus, OTel 표준 shape이
아닌 ClickHouse, 임의 라벨만 있는 Loki에서는 카탈로그가 ready 0행을 내고, 사용자는 빈 패널을 본다.
이때 **그 인스턴스의 실제 스키마 이름**을 근거로 Bedrock(Haiku)에 쿼리 1건을 생성시키는 폴백이 두 곳에
있다:

- `scripts/v2/workers/graph_querygen.py` — ClickHouse `trace_spans` 그래프 쿼리 1건 (`graph_querygen_enabled`)
- `scripts/v2/workers/diagnosis/signal_catalog_gen.py` — Explore diag-signal 칩 1건 (`diag_signal_querygen_enabled`)

두 경로는 **한 종류의 동의**를 요구한다: 외부 데이터소스의 식별자를 모델에 보내고, 모델이 쓴 조회문을
그 데이터소스에 실행한다. ADR-007(외부 데이터 통합 거버넌스)은 커넥터·SSRF·시크릿·human-gate를 다루지만
"모델이 쿼리를 쓴다"는 사실 자체는 다루지 않는다. ADR-005(AWS 리소스 변경·자율 FROZEN)와는 무관하다 —
생성물은 SQL/PromQL/LogQL 조회문이고 AWS API 호출 경로가 아니다.

## Decision / 결정

**결정론 매처가 ready 0행을 낸 인스턴스에 한해, 스키마 어휘를 근거로 LLM이 조회문 1건을 생성하는 것을
허용한다. 각 경로는 자기 플래그(기본 false) 뒤에 있다.**

아래는 **공통 동의(A)** 와 **경로별 방어(B/C)** 를 구조로 갈라 적는다. 한 문장이 두 경로에 다 적용되는 것처럼
읽히면 리뷰어가 없는 방어를 있다고 믿게 되므로(리뷰 MAJOR, 2회), 공통 절에는 두 경로에 **실제로 모두** 있는
것만 둔다.

### A. 두 경로 공통 — 이것이 "동의"의 내용

1. **스키마 식별자가 Bedrock으로 나간다.** 테이블/컬럼/메트릭/라벨 **이름**만 나가고 데이터 행·자격증명은
   나가지 않는다.
2. **모델이 쓴 조회문을 라이브로 dry-run 한다.** 실행은 기존 read-only 커넥터에서만 이뤄지고, 모델은 실행
   권한을 갖지 않는다. **`assert_host_allowed`(SSRF 호스트 핀, `datasource_http.py`)는 모든 kind 공통 가드다**
   (`prometheus_mcp.py`·`loki_mcp.py`·`tempo_mcp.py`·`mimir_mcp.py`·`clickhouse_mcp.py` 전부 호출). `readonly=1` ·
   `assert_read_only`는 **ClickHouse 전용**이다 — Prometheus/Mimir/Loki/Tempo API 자체가 읽기 전용 엔드포인트라
   SQL 레벨 read-only 강제가 필요 없다(그 API들엔 애초에 mutating 호출이 없다). dry-run 이 error envelope 나
   빈 payload 를 돌려주면 그 후보는 캐시되지 않는다.
3. **정적 게이트를 먼저 통과해야 한다** — **ClickHouse만** mutating 키워드 denylist + 단일문 검사를 한다
   (`signal_catalog_gen._static_check`는 `kind == "clickhouse"`일 때만 이 검사를 수행하고, 다른 kind는
   그대로 통과시킨다 — PromQL/LogQL/TraceQL 에는 애초에 mutating 동사가 없으므로 no-op). graph 경로의
   `graph_querygen._static_readonly_check`도 ClickHouse `trace_spans` 전용이라 마찬가지다. **생성기
   단계의 table-function denylist(`url`/`s3`/`remote` 등 SSRF 표면)는 diag-signal 쪽에만 있다** — graph 쪽은
   실행 시 커넥터의 `assert_read_only(extra_forbidden_re=_TABLE_FN)` 이 막는다. 즉 파이프라인은 두 경로 모두
   보호되지만 *어느 층에서* 막느냐가 다르다(리뷰 MAJOR-8: 이 차이를 "공통"으로 뭉개면 안 된다).
4. **캐시된 결과만 쓴다** — 생성물은 스키마 버전에 키를 두고 저장되며, 매 실행 재생성이 아니다.
5. **ADR-005와 무관하다** — 생성물은 SQL/PromQL/LogQL 조회문이고 AWS API 호출 경로가 아니다.

### B. `signal_catalog_gen` (diag-signal 칩) 전용 방어 — graph 경로에는 **없다**

1. **식별자 정화**: 평범한 식별자만(`^[A-Za-z_][\w.:-]*$`) 60개 상한으로 프롬프트에 넣는다(프롬프트 인젝션).
2. **관련성 게이트**: 그 인스턴스 어휘를 실제로 언급하고 상수를 측정하지 않아야 한다.
3. **dry-run 상한 + 빈 응답의 분류**: ClickHouse `max_execution_time=5`+`max_rows=1`, Prometheus/Mimir `timeout=5s`,
   Loki/Tempo `limit=1`. **Loki/Tempo는 커넥터를 통한 서버측 실행시간 상한이 없다** — 알려진 잔여 리스크이며,
   그래서 생성 표현식을 자동 반복 실행 경로에 두지 않는다. 빈 응답은 §A-2 대로 캐시되지 않지만, 그 **분류**는
   REJECTED 가 아니라 TRANSIENT 다 — 조용한 시간대의 정상 datasource 가 영구 skip 되지 않도록 주간 예산
   안에서 재시도한다.
4. **비용 예산**: 인스턴스당 **ISO 주 3회**, 그리고 **연속 3주** 소진되면 스키마가 바뀔 때까지 정지
   (`_MAX_SPENT_WEEKS`). 마커(`:<pend|done>N w<주차>[s<연속소진주차수>]`)는 **콘텐츠 행의 `schema_version`
   컬럼과 완전히 분리된 전용 북키핑 행**(`__diag_signal_budget__`, `meta.budget` 필드)에만 저장한다 — 콘텐츠
   행은 항상 **현재** 스키마의 진짜 버전만 가지므로, 스키마 롤백이 일치검사를 거짓으로 통과시켜 잘못 태깅된
   콘텐츠를 서빙하는 경로가 없다. 마커는 `pend`(재시도 미결)/`done`(이번 주 소진, 연속-소진 아님)/`conc`
   (이 스키마에 대해 결론적으로 정산 — 주 경계가 지나도 유효, `attempts`/연속소진주차수를 계속 보존) **3-state**
   다. 이번 주에 아무것도 쓰지 않았고 연속소진주차수도 0인 **conclusive** 결과(ready 정산 또는 플래그
   꺼짐/DISABLED)만 북키핑 행을 남기지 않는다 — 그 외의 모든 conclusive 결과(이번 주에 attempts를 썼거나
   연속소진주차수가 있는 경우)는 `conc` 마커로 그 상태를 보존해, 다음 실행이 "정산됐다"는 사실과 "이번 주
   이미 얼마를 썼다"는 사실을 둘 다 잃지 않게 한다. 마커는 주 안에서는 스키마 해시와 무관하게 읽어 churn 이
   예산을 리셋하지 못하게 한다. **연속 3주
   park**(스키마 무관) 해제는 **주 경계에서만** 일어나며, 그 시점에 스키마가 실제로 바뀌었으면 해제한다 — 같은
   주 안의 스키마 변경은 주간 상한 자체를 갱신하지 않는다(인스턴스당 주 3회는 스키마별이 아니라 인스턴스당
   하드 상한). 플래그가 꺼진 기간은 과금하지 않는다. **v4→v5 전환**: 이 북키핑 행은 v5 부터 존재하므로,
   `datasource_index.py`는 예산 행이 없고 콘텐츠의 저장된 `schema_version`이 v4 시절 마커 문자열이면
   부트스트랩한다 — **연속소진주차수(streak)만** 이어받고, attempts 는 옛 마커의 주차가 **현재 주와 같을
   때만**(배포가 주 중간에 일어난 경우) 이어받는다. v4 해시와 v5 해시는 어느 방향으로도 비교 불가능하므로,
   부트스트랩은 옛 해시를 그대로 유지하거나 현재 버전으로 재고정하지 않고 항상 정직한 fresh `pend` 상태로
   시작한다.
5. **플래그를 끄면 제공이 멈춘다 — 쓰기와 읽기 양쪽에서.** 저장된 생성 행은 검증 실패/park 구간에 보존되지만
   그 보존이 플래그 뒤에 있어 게이트를 닫으면 다음 rebuild의 sweep이 걷어낸다. **그 rebuild는 워커가 돌아야
   일어나므로** BFF read path도 같은 플래그로 게이트한다(`web/lib/diag-signals.ts`, web task env
   `DIAG_SIGNAL_QUERYGEN_ENABLED`).
6. **소비 표면 제한**: `provenance='generated'` 행은 Explore 칩 전용이며 진단 리포트 경로(`_signal_plan`)에서
   제외된다 — 리포트 프롬프트는 `pillar`/`threshold`로 심각도를 판정하고 생성 행에는 그 근거가 없다.

### C. `graph_querygen` (ClickHouse `trace_spans` 1건) 전용 — B의 방어는 아직 적용되지 않는다

1. **AgentCore Code Interpreter 사전검사**(advisory, `agentcore_enabled` 필요) — B에는 없는 단계다.
2. **필수 alias 존재 검사** + `LIMIT 1` dry-run.
3. 식별자 정화·관련성 게이트·주간 예산·읽기 게이트·생성기 단계 table-function denylist는 **없다**(마지막 항목은 실행 시 커넥터가 막는다 — §A-3). 범위가 ClickHouse `trace_spans` 쿼리 1건으로
   좁고 소비 표면이 토폴로지 그래프 하나이기 때문에 현재로선 수용하지만, **의도된 설계가 아니라 현행 사실**이다.
   B의 방어를 C로 넓히는 것은 후속 작업이며, 그 전에 `graph_querygen_enabled` 의 범위를 넓히지 않는다.

**어느 경로에서도 허용하지 않는 것**: 모델이 쓴 문장으로 데이터를 변경하는 것(A-3이 차단), AWS API 호출(경로
자체가 없음), 사용자 프롬프트를 그대로 쿼리로 실행하는 것(프롬프트는 코드 안 템플릿 + 스키마 어휘뿐).
**diag-signal 경로에서 추가로** 허용하지 않는 것: 생성물을 자동 판정/알림의 근거로 쓰는 것(B-6).

## Consequences / 결과

### Positive / 긍정
- 카탈로그가 커버하지 못하는 스키마에서도 사용자가 최소 한 개의 유효한 시작 쿼리를 얻는다.
- 게이트가 층으로 쌓여 있어(정적 → 관련성 → dry-run) 어느 층이 무엇을 막는지 리뷰 가능하다.
- 비용 상한이 코드에 있고 테스트로 고정되어, "LLM이 매일 도는" 형태로 조용히 번지지 않는다.

### Negative / 부정 (수용된 잔여 리스크)
- Loki/Tempo dry-run에는 서버측 실행시간 상한이 없다(§B-3).
- diag-signal 경로의 관련성 게이트는 정규식 기반이며 SQL/PromQL 파서가 아니다 — 우회 가능성이 남고, 실제로 리뷰에서 여러
  차례 우회 사례가 발견되어 그때마다 좁혔다. 이 게이트는 "정확성 판정"이 아니라 "명백한 무관/상수 차단"이며,
  다음 우회가 나오면 개별 패턴을 덧대기보다 커넥터 파서(예: ClickHouse `EXPLAIN AST`)로 옮기는 것이 옳다.
- 생성 칩의 품질은 보장되지 않는다 — 사용자가 읽고 판단하는 표면이라는 전제(§B-6)가 이 리스크의 상한이다.

## 6 Pillars
- **Operational Excellence** — 폴백은 결정론 카탈로그를 대체하지 않고 보완한다. 실패는 항상 카탈로그 결과로
  되돌아가며(never raises), diag-signal 경로의 주간 예산·마커가 운영 로그에 남는다.
- **Security** — 공통: read-only 커넥터 + SSRF 호스트 검사, 모델은 실행 권한이 없다. **정정(리뷰
  2026-08-06, PR #205): graph 경로도 diag-signal과 같은 ClickHouse 커넥터를 거치므로 "다른 커넥터라 가드가
  없다"는 서술은 틀렸다 — §A-3이 정확한 서술이다.** 두 경로 모두 실행 시 동일 커넥터의
  `assert_read_only(extra_forbidden_re=_TABLE_FN)`이 table-function(SSRF 표면) + mutating SQL을 막는다.
  차이는 *어느 층에서* 막느냐뿐이다: diag-signal(`signal_catalog_gen`)은 생성기 단계에서도 `_TABLE_FN`/
  `SETTINGS`를 사전차단하지만(§A-3), graph(`graph_querygen`)는 생성기 단계 사전차단이 없고 실행 시 커넥터
  가드에만 의존한다. diag-signal 경로에는 식별자 정화도 추가된다(graph 경로에는 없음 — §C-3).
- **Reliability** — diag-signal 경로: 일시 실패는 주 3회 상한으로 재시도, 소진은 주 경계에서 해제, 검증된 칩은
  재검증 실패로 삭제되지 않는다. graph 경로: schema_version 캐시가 재생성 시점을 정한다.
- **Performance** — diag-signal dry-run은 커넥터가 지원하는 최소 상한으로 실행된다(§B-3). graph dry-run은
  ClickHouse `LIMIT 1`이다.
- **Cost** — Haiku 1콜. diag-signal 경로는 인스턴스당 주 3회 상한이 있고 꺼진 기간은 무과금이며, graph 경로는
  주간 상한 없이 schema_version 드리프트에만 의존한다(§C-3).
- **Sustainability** — 두 경로 모두 생성물을 캐시하여 스키마가 바뀔 때만 재생성한다(불필요한 반복 추론 없음).
