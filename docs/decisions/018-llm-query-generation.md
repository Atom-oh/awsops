# ADR-018: LLM 쿼리 생성 (읽기 전용) / LLM Query Generation (read-only)

## Status / 상태
**Accepted — 두 경로 모두 GATED, 기본 false: `graph_querygen_enabled`, `diag_signal_querygen_enabled`.**

이 ADR은 새 권한이나 새 substrate를 만들지 않는다. 이미 존재하는 두 폴백 경로(그래프 쿼리 1건 · Explore
diag-signal 칩 1건)가 **공통으로 무엇에 동의하는지**를 한곳에 적어, 리뷰어가 "이건 어느 결정에 속하는가"를
BASELINE 행의 각주로 추론하지 않게 한다. PR #205 리뷰가 지적한 귀속 공백(ADR-007은 external-data
collector/SSRF 거버넌스이고 아래 4항목을 다루지 않는다)을 닫는 것이 이 문서의 존재 이유다.

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
허용한다. 각 경로는 자기 플래그(기본 false) 뒤에 있고, 아래 네 가지가 동의의 내용이다.**

1. **스키마 식별자가 Bedrock으로 나간다.** 테이블/컬럼/메트릭/라벨 **이름**만 나가고 데이터 행·자격증명은
   나가지 않는다. 데이터소스는 사용자 등록 대상이므로 식별자는 신뢰 경계 밖이다 → 평범한 식별자만
   (`^[A-Za-z_][\w.:-]*$`), 60개 상한으로 프롬프트에 넣는다(프롬프트 인젝션 방어).
2. **모델이 쓴 조회문을 라이브로 dry-run 한다.** 실행 전에 (a) 정적 read-only/단일문/table-function
   denylist, (b) 관련성 게이트(그 인스턴스 어휘를 실제로 언급하고 상수를 측정하지 않음)를 통과해야 하며,
   실행은 기존 read-only 커넥터에서만(`readonly=1`·`assert_read_only`·`assert_host_allowed`) 이뤄진다.
   dry-run은 커넥터가 받는 상한을 건다: ClickHouse `max_execution_time=5`+`max_rows=1`,
   Prometheus/Mimir `timeout=5s`, Loki/Tempo `limit=1`. **Loki/Tempo는 커넥터를 통한 서버측 실행시간
   상한이 없다** — 알려진 잔여 리스크이며, 그래서 생성 표현식을 자동 반복 실행 경로에 두지 않는다.
3. **비용은 예산으로 제한한다.** 인스턴스당 **ISO 주 3회** 생성. 마커(`:<pend|done>N w<주차>`)는 스키마
   해시와 독립적으로 읽어 스키마 churn이 예산을 리셋하지 못하게 하고, conclusive 결과에서도 사용량을
   유지해 flap이 예산을 사지 못하게 한다. 플래그가 꺼진 기간은 과금하지 않는다.
4. **플래그를 끄면 생성물 제공이 멈춘다.** 이미 저장된 생성 행은 검증 실패/park 구간에서 보존되지만
   (일시 장애가 검증된 칩을 지우지 않도록), 그 보존 자체가 플래그 뒤에 있다 — 게이트를 닫으면 다음 rebuild의
   sweep이 생성 행을 걷어낸다.
5. **생성물은 사용자가 읽는 표면에만 쓴다.** `provenance='generated'` 행은 Explore 칩 전용이며,
   진단 리포트 경로(`_signal_plan`)에서 제외된다 — 리포트 프롬프트는 `pillar`/`threshold`로 심각도를
   판정하고 생성 행에는 그 근거가 없다. 임계 판정 근거 없는 신호가 판정을 끌면 그것은 오진이다.

**허용하지 않는 것**: 모델이 쓴 문장으로 데이터를 변경하는 것(정적 게이트가 차단), AWS API 호출(경로
자체가 없음), 생성물을 자동 판정/알림의 근거로 쓰는 것(§4), 사용자 프롬프트를 그대로 쿼리로 실행하는 것
(생성 프롬프트는 코드 안 템플릿 + 스키마 어휘뿐).

## Consequences / 결과

### Positive / 긍정
- 카탈로그가 커버하지 못하는 스키마에서도 사용자가 최소 한 개의 유효한 시작 쿼리를 얻는다.
- 게이트가 층으로 쌓여 있어(정적 → 관련성 → dry-run) 어느 층이 무엇을 막는지 리뷰 가능하다.
- 비용 상한이 코드에 있고 테스트로 고정되어, "LLM이 매일 도는" 형태로 조용히 번지지 않는다.

### Negative / 부정 (수용된 잔여 리스크)
- Loki/Tempo dry-run에는 서버측 실행시간 상한이 없다(위 §2).
- 관련성 게이트는 정규식 기반이며 SQL/PromQL 파서가 아니다 — 우회 가능성이 남고, 실제로 리뷰에서 여러
  차례 우회 사례가 발견되어 그때마다 좁혔다. 이 게이트는 "정확성 판정"이 아니라 "명백한 무관/상수 차단"이며,
  다음 우회가 나오면 개별 패턴을 덧대기보다 커넥터 파서(예: ClickHouse `EXPLAIN AST`)로 옮기는 것이 옳다.
- 생성 칩의 품질은 보장되지 않는다 — 사용자가 읽고 판단하는 표면이라는 전제(§4)가 이 리스크의 상한이다.

## 6 Pillars
- **Operational Excellence** — 폴백은 결정론 카탈로그를 대체하지 않고 보완한다. 실패는 항상 카탈로그
  결과로 되돌아가며(never raises), 주간 예산과 마커가 운영 로그에 남는다.
- **Security** — 식별자 정화 + 정적 read-only/denylist + read-only 커넥터 + SSRF 호스트 검사. 모델은
  실행 권한을 갖지 않고, 실행은 언제나 기존 커넥터 경로다.
- **Reliability** — 일시 실패는 재시도(주 3회 상한), 소진은 주 경계에서 해제, 검증된 칩은 재검증 실패로
  삭제되지 않는다.
- **Performance** — dry-run은 커넥터가 지원하는 최소 상한으로 실행된다(§2).
- **Cost** — Haiku 1콜 × 인스턴스당 주 3회 상한, 기본 false. 꺼진 기간은 무과금.
- **Sustainability** — 생성물은 캐시되어 스키마가 바뀔 때만 재생성된다(불필요한 반복 추론 없음).
