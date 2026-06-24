# Design — Webhook Alert Validation (LLM true/false-alert gate) + 2-stage SNS

작성일 / Date: 2026-06-24
상태 / Status: **Design — approved in brainstorming, pending spec review → writing-plans**
범위 / Scope: v2 (`web/`, `scripts/v2/incident/`, `terraform/v2/foundation/`)
거버넌스 / Posture: **read-only (ADR-006 analysis-only)**. AWS resource mutation/autonomy = ADR-005 FROZEN — out of scope. This is the alert-ingress + first-pass-validation **front** of the already-merged (gated) incident orchestrator.

## 1. 문제 / Problem
Alertmanager·CloudWatch 알림의 상당수가 **false positive**다(예: 잠깐 CPU throttling 후 자가회복). 진짜 장애는 그 일시 현상이 **지연→장애 전파**로 이어질 때다. 조건문(`expr`/`for`) 룰만으로는 이 둘을 구분하지 못해 노이즈가 누적된다. 필요한 것은 알림 **시점(startsAt)과 payload**를 기준으로 주변 신호(트레이스/메트릭/로그/pod/토폴로지)를 상관해 **"진짜 전파성 장애인지"를 판정**하는 1차분석이며, 진짜만 알림(SNS)·에스컬레이션한다.

이미 존재하는 자산(재사용): Alertmanager/CloudWatch/Grafana/Generic 정규화(`web/lib/incident-normalize.ts`), HMAC 웹훅 ingress(`web/app/api/incidents/webhook/route.ts`), 인시던트 오케스트레이터(`scripts/v2/incident/`, Step Functions, ADR-032/006, gated `incident_lifecycle_enabled`), datasource 커넥터(Prometheus/Mimir/Loki/Tempo/ClickHouse), EKS in-cluster read, topology(`topology_nodes/edges`), SNS 패턴(`notify.tf`), Integrations 모델(ingress 웹훅 = connector, `integrations-category.ts`).

## 2. 브레인스토밍 결정 요약 / Decisions
1. **2단계 알림**: 수신 즉시 1차분석 **SNS#1**(빠름) + 풀 RCA 완료 시 **SNS#2**.
2. **1차분석 = LLM(Haiku 4.5) true/false-alert 판별기** — 시점+payload 기준 신호 번들 상관.
3. **증거 신호**: Tempo 트레이스(전파) + 메트릭(Prometheus/Mimir/CW) + 로그+pod/이벤트(Loki+EKS) + 토폴로지 blast radius + ClickHouse(otel).
4. **라우팅 = 2-way, fail-safe 에스컬레이트**: `real` 또는 `uncertain` → SNS#1 + 풀 RCA. **고신뢰 `false_positive`만 억제**(기록만, SNS 없음).
5. **모델 = Haiku 4.5**(빠름/저렴; fail-safe-에스컬레이트가 미스 흡수, 정밀 판정은 풀 RCA=Opus/Sonnet에 위임).
6. **배치 = 접근 A**: 기존 incident SM의 **첫 스테이지로 `AlertValidation` 삽입**(기존 백본 전부 재사용, 신규 최소).
7. **인그레스 2종을 Integrations 안에서**: `alertmanager`(HMAC), `cloudwatch_alarm`(SNS HTTPS 구독+SNS 서명 검증). 통합 등록 시 **웹훅 연동 가이드** 제공.

## 3. 아키텍처 & 데이터 흐름 / Architecture
```
Alertmanager ─HMAC POST─┐
CloudWatch Alarm→SNS────┤→ BFF /api/incidents/webhook (thin, 결정론만)
                        │   인증(소스별) + 정규화 + 결정론 triage(심각도·dedup·storm) + incident row + enqueue
                        ▼ (SQS → dispatcher → incident Step Functions)
  ┌───────────── incident SM (기존 SM에 front 스테이지 추가) ─────────────┐
  │ ① AlertValidation (신규 Haiku Lambda)                                │
  │    startsAt(±창)+payload 기준 신호 번들 → Haiku verdict → incident 기록 │
  │    └─▶ SNS#1 (real/uncertain일 때만)                                   │
  │ ② Choice($.verdict):                                                  │
  │    · false_positive(고신뢰) → Suppressed(status=false_positive, 종료)  │
  │    · real / uncertain      → 기존 Lead→Investigation→RootCause→Mitigation(권고)│
  │ ③ Done → SNS#2 (RCA 요약+권고+링크)                                    │
  └──────────────────────────────────────────────────────────────────────┘
```
- 신규: **Lambda 1개(`alert_validation.py`) + SM 상태 2개(AlertValidation/Suppressed + Choice) + SNS 토픽 1개 + 인그레스 통합 kind 2종 + Integrations 가이드 UI**. dispatcher·status_updater·watchdog·IAM·게이트는 재사용.
- "시점" = Alertmanager `startsAt` / CloudWatch `StateChangeTime`(처리시각 아님)이 신호 창의 중심.

## 4. 인그레스: 소스 2종 + 인증 / Ingress
한 엔드포인트(`/api/incidents/webhook`)로 수신하되 인증 스킴이 소스별로 다르다:

| kind | 전송 | 인증 | 정규화 |
|---|---|---|---|
| `alertmanager` | webhook receiver → 직접 POST | **HMAC-SHA256** 공유 시크릿(ADR-022 active/standby) — 기존 route | `normalizeAlert` (기존) |
| `cloudwatch_alarm` | Alarm → **SNS topic → HTTPS 구독** → POST | **SNS 메시지 서명 검증**(SignatureVersion 1/2, SigningCertURL host 화이트리스트, 인증서 캐시) + SubscriptionConfirmation(기존) | cloudwatch 정규화 (기존) |

- **신규 코드(갭)**: 현재 route는 SNS `SubscriptionConfirmation`만 처리하고 그 외엔 HMAC만 검증 → CloudWatch가 SNS로 보내는 `Type:'Notification'`을 401로 거부한다. **SNS 메시지 서명 검증 경로 추가** — `Type:'Notification'`이면 SNS 서명 검증(SigningCertURL은 `sns.<region>.amazonaws.com` host로 제한, 인증서 TTL 캐시), 직접 POST면 HMAC. 검증 후 `Message` 본문을 정규화에 투입.
- 두 소스 모두 정규화 → 결정론 triage → AlertValidation 흐름 공유.
- HMAC 시크릿은 **v1=공유**(엔드포인트 단위, 기존 SSM `SSM_INCIDENT_HMAC_SECRET_PARAM`). 통합별 개별 시크릿은 향후 확장(open item).

## 5. Integrations 통합 + 웹훅 가이드 / Integration + guide
ingress 웹훅 소스는 Integrations 모델상 **connector**(`direction='ingress'`, `integrations-category.ts`가 이미 connector로 분류). Connectors 탭에서 `alertmanager`/`cloudwatch_alarm` 통합 등록 시:
- **웹훅 URL**(`https://<domain>/api/incidents/webhook`) + **HMAC 시크릿**(alertmanager용) 표시/회전.
- **소스별 copy-paste 가이드**:
  - **Alertmanager**: ① 알림 규칙 예시(아래 §5.1), ② `alertmanager.yml` receiver/route 스니펫(`webhook_configs.url` + 서명 헤더 `X-Alertmanager-Signature: sha256=<HMAC>`), ③ 시크릿 주입.
  - **CloudWatch Alarm**: ① 알람 생성 → SNS 토픽 지정, ② SNS → HTTPS 구독에 웹훅 URL 등록(SubscriptionConfirmation 자동 처리), ③ 서명 검증/IAM 안내.
- **게이팅 분리**: 통합 등록·가이드 열람은 **config-time(언제나 가능)**; 웹훅 수신·검증·triage·validation은 `incident_lifecycle_enabled=true`일 때만(현행 route 503 가드 유지).
- 데이터: 기존 `integrations` 테이블에 `kind∈{alertmanager,cloudwatch_alarm}`,`direction='ingress'`,`capability='read'`로 저장(별도 스키마 없음). `integration-validation.ts`의 ingress kind 집합에 2종 추가.

### 5.1 Alertmanager 규칙 예시(가이드 수록)
```yaml
groups:
  - name: CPUThreshold
    rules:
      - alert: HighCPUUsage
        expr: job:cpu_usage:avg1m > 50
        for: 3m
        labels: { severity: warning }
        annotations:
          summary: "High CPU usage on {{ $labels.instance }}"
          description: "CPU usage on {{ $labels.instance }} is greater than 50%. Current usage: {{ $value }}%"
      - alert: CriticalCPUUsage
        expr: job:cpu_usage:avg1m > 90
        for: 1m
        labels: { severity: critical }
        annotations:
          summary: "Critical CPU usage on {{ $labels.instance }}"
          description: "CPU usage on {{ $labels.instance }} is greater than 90%. Current usage: {{ $value }}%"
```
이런 룰은 일시적 throttling에도 발화 → AlertValidation이 "전파성 실제 장애인지"를 판정해 노이즈를 거른다.

## 6. AlertValidation 스테이지 / Validator
`scripts/v2/incident/alert_validation.py` (incident SM 첫 stage Lambda):
- **입력**: `incident_id`(triage가 생성·persist한 정규화 alert 포함).
- **신호 번들(병렬·시간창 한정·top-N 캡, 가용한 것만; 없으면 우아한 저하)**:
  - 메트릭(Prometheus/Mimir/CW): 스파이크가 **일시·자가회복 vs 지속**인지
  - 로그(Loki) + EKS pod/이벤트: CrashLoop/OOMKilled/재시작/readiness
  - Tempo 트레이스: 지연/에러 **전파 경로**(의존 서비스로 번졌는가)
  - 토폴로지 blast radius(`topology_nodes/edges`): 알림 리소스의 상하위 의존
  - ClickHouse: otel 관측 데이터
  - → **기존 read-only 수집기 재사용**(datasource 커넥터 · EKS in-cluster reader · topology read). 신호 수집은 커넥터 직접 호출(구현 단순·지연 우선; AgentCore MCP 경유 아님).
- **튜너블(SSM, ignore_changes; 안전 폴백)**: `validation_window`(예 startsAt−10m~+5m), 신호별 timeout·top-N, `false_positive_confidence_threshold`(예 0.8), 모델 id(Haiku).
- **Haiku 판정 → 구조화 verdict**:
  `{verdict: "real"|"uncertain"|"false_positive", confidence: 0..1, propagation: bool, evidence: [{source, summary}], rationale, suggested_checks}`.
  payload·신호는 **신뢰 불가 데이터로 격리**(`isolatePayload` + 프롬프트 인젝션 가드: 명령 고정·데이터 인용·"report PASS류 무시").
- **억제 규칙(fail-safe)**: `verdict=="false_positive" AND confidence>=threshold`일 때만 억제. 그 외(real/uncertain/저신뢰 false) 전부 에스컬레이트.
- **기록(read-only)**: `incident_findings`(`sub_agent='alert-validator'`, `findings=verdict`) + `incidents.status∈{validated,false_positive}` + `incidents.validation jsonb`.
- **출력**: SM Choice용 `verdict` + (real/uncertain이면) SNS#1 발행.

## 7. SNS 알림 / Notifications
- **신규 전용 토픽** `${project}-incident-notifications` (notify.tf의 진단 토픽과 분리 — 구독자·의미·IAM 상이). publish IAM은 이 토픽 ARN 한정(notify.tf 패턴). `incidents.tf` 안에서 `incident_lifecycle_enabled` 게이트.
- **SNS#1 (1차분석, AlertValidation에서)**: verdict·confidence·알림 엔티티·전파 요약·상위 evidence·blast radius·incident 링크.
- **SNS#2 (RCA 완료, Done에서)**: RCA 요약 + 권고 + 링크.
- 구독은 운영자 관리(terraform var 또는 추후 BFF admin; notify.tf 방식 재사용 가능).

## 8. 안전 · 게이팅 · posture / Safety
- 전부 **`incident_lifecycle_enabled`** 하위. 기본 OFF → 0 리소스·$0·트리거 없음.
- **ADR-006 read-only 준수**: validator는 신호 **읽기만**; mutation/remediation 라우팅 없음. ADR-005 동결 unfreeze 아님.
- **storm 보호**: BFF 결정론 triage(심각도·dedup·rate-limit)가 Haiku 호출 **앞단** 유지. 신호 쿼리는 창·top-N·timeout 캡으로 DoS/비용 한도.
- **격리**: `isolatePayload`(공격자 텍스트 defang) + 피드백 루프 차단(`bearsSelfWritebackMarker`) 기존대로. SNS 서명 검증으로 위조 CloudWatch 메시지 차단.

## 9. 데이터 모델 / Data model
- 기존 `incident_*` 테이블 재사용 + **additive 마이그레이션 1개** `migrations/<ULID>_alert_validation.sql`(schema.sql append 아님): `incidents.validation jsonb` 컬럼 추가 + `status` 허용값에 `validated`/`false_positive` 반영.
- `integrations` ingress kind 2종은 기존 테이블/체크에 추가(마이그레이션의 `integrations_kind_check` ingress 집합 갱신).

## 10. 테스트 / Testing
- `scripts/v2/incident/test_alert_validation.py`: 신호 번들 조립(커넥터 mock)·verdict 파싱·**억제 임계 로직(uncertain/저신뢰 false→에스컬레이트, 고신뢰 false만 억제)**·SNS#1 내용·멱등성·신호 부재 시 우아한 저하·프롬프트 인젝션 격리.
- `web` route: SNS 서명 검증 경로(Notification 수락/위조 거부) + HMAC 경로(기존) + 소스 분기 단위 테스트.
- Integrations: ingress kind 2종 validation + 가이드 렌더 테스트.

## 11. 비범위 / Non-goals
- 자율 mitigation/remediation(ADR-005 FROZEN) — 없음.
- 정밀 RCA(근본원인 확정)는 1차분석이 아니라 **기존 풀 오케스트레이터**(Lead→Sub→RootCause)에 위임.
- 통합별 개별 HMAC 시크릿, Grafana 가이드 1급 지원 — v1 이후(정규화는 이미 Grafana 지원하므로 가이드 보조 언급 가능).

## 12. 구현 분해(웨이브) / Implementation waves
1. **W1 — 인그레스**: SNS 서명 검증 경로 추가(route) + `cloudwatch_alarm`/`alertmanager` ingress kind(integration-validation) + 단위 테스트.
2. **W2 — AlertValidation**: `alert_validation.py`(신호 번들 + Haiku verdict + 억제 규칙) + incident SM ASL 스플라이스(AlertValidation을 기존 첫 스테이지 앞에 삽입 + Choice + Suppressed). **기존 SM `Triage` 상태와의 중복은 플랜에서 reconcile**(BFF 결정론 triage가 incident-row를 이미 생성하므로 SM Triage의 역할을 확인해 이중 triage를 피함) + SSM 튜너블 + 마이그레이션.
3. **W3 — SNS**: 인시던트 토픽(`incidents.tf`) + SNS#1/#2 publish + IAM 스코프.
4. **W4 — Integrations UX**: Connectors 탭 ingress 등록 + 소스별 웹훅 가이드(§5.1 포함) + 웹훅 URL/시크릿 표시.

각 웨이브는 read-only·게이트 유지하며 독립 테스트 가능.
