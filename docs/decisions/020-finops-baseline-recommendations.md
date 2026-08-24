# ADR-020: FinOps 기본 권장 엔진 (결정론적 룰 + LLM 설명) / FinOps Baseline Recommendations (Deterministic Rules + LLM Explanation)

## Status / 상태

**Accepted (2026-08-19).** Extends **ADR-012** (Cost/FinOps) with a new decision — ADR-012 itself is unchanged; this ADR adds decision §5 to that domain.
**채택됨 (2026-08-19).** **ADR-012**(Cost/FinOps)를 확장한다 — ADR-012 본문은 그대로이며, 이 ADR이 해당 도메인의 결정 §5를 추가한다.

## Context / 컨텍스트

ADR-012는 지출 가시성(추세·MoM·예측)과 채팅 전용 FinOps MCP 권고 도구를 다룬다. 둘 다 "지금 이 환경이 상시로 새고 있는 것"을 사용자가 별도 설정 없이 볼 수 있는 상시 표면이 아니다. `/cost` 페이지에는 그런 표면이 없고, 유사한 로직(미사용 EIP·gp2 볼륨·VPC 엔드포인트 커버리지 갭 등)은 세 곳에 흩어져 있으며 그중 다수는 `steampipeAvailable()`이 상시 `false`를 반환해(ADR-001/010) 실행되지 않는 dark code다.

이 도메인은 **CUR(Cost and Usage Report)/Athena/FOCUS가 저장소에 전혀 없다**는 제약 위에서 설계해야 한다. 금액 근거는 Cost Explorer API의 `GROUP BY USAGE_TYPE`/`SERVICE` 그룹핑, 이미 동기화된 `inventory_resources`, Compute Optimizer/Cost Optimization Hub/Budgets API로 한정된다. 태그 커버리지 상세·AI 토큰 라인아이템처럼 CUR 2.0 라인아이템에만 있는 데이터는 이번 범위에서 산출할 수 없다.

ADR-012 does not describe an always-on "what is leaking right now" surface. Existing overlapping logic (idle EIPs, gp2 volumes, VPC-endpoint coverage gaps) is scattered across three places, much of it unreachable dark code. This domain must be designed knowing **CUR/Athena/FOCUS do not exist in this repo** — cost evidence is limited to the Cost Explorer API's usage-type/service grouping, `inventory_resources`, and Compute Optimizer/Cost Optimization Hub/Budgets. Anything that requires CUR 2.0 line-item detail is out of scope for now.

## Decision / 결정

- **결정론적 룰 엔진이 판정·금액을 소유한다** (별도 엔진 소유 `priority` 필드는 아직 없음 — §"엔진이 소유하는 우선순위는 없다" 참조). LLM은 이미 확정된 finding에 대한 한국어 설명만 덧붙이며, 계산·추정·순위 재조정을 하지 않는다. 설명이 finding의 확정 숫자와 불일치하면 그 설명은 폐기되고 `null`로 남는다 — LLM 계층이 죽어도 기능은 완전히 동작한다.
- **금액 근거는 `inventory_resources`의 published rate card(EBS) + Compute Optimizer 자체 추정(EC2/RDS)으로 한정 — 이번 PR에 Cost Explorer/Cost Optimization Hub/Budgets 호출은 없다.** ADR 초안은 CE/COH/Budgets까지 포괄하는 것으로 서술했으나, PR #232 리뷰에서 실제 구현이 그보다 좁다는 드리프트가 지적되어 이 절을 실제 범위로 좁혔다 — CE/COH/Budgets 기반 룰과 `ce_api_calls` 계측은 **향후 확장**으로 남기고, 착수 시 이 ADR을 갱신한다. CUR을 전제로 하는 룰(태그 커버리지 지출 상세, Bedrock 토큰 라인아이템 등)은 룰 카탈로그에 `status: requires_cur`로만 등록하고 실행하지 않는다 — 산출 불가를 조용히 감추지 않는다.
- **절감액을 산출할 수 없으면 `NULL`이며 `0`으로 채우지 않는다.** 합계 오염을 막기 위한 불변식.
- **read-only.** 이 도메인은 AWS 리소스를 변경하는 경로를 하나도 추가하지 않는다 — ADR-005(FROZEN)는 이 결정과 무관하다. 권장 카드에 IaC 변경 예시를 텍스트로 표시하는 것은 허용되나 실행 버튼은 존재하지 않는다.
- **일별 배치 적재, 요청 경로에서 라이브 AWS 호출 없음.** `finops_baseline_enabled` 플래그(기본 false, terraform 레벨로는 `workers_enabled`만 요구)로 게이팅된 Fargate 워커 job이 하루 한 번 Compute Optimizer(EC2/RDS 인스턴스 권장)를 호출하고 동기화된 `inventory_resources`를 읽어 `finops_findings`에 적재하며, `/cost`의 새 섹션은 Aurora만 읽는다. 이 job의 Compute Optimizer 권한(`GetEC2InstanceRecommendations`/`GetRDSDatabaseRecommendations`만, 실제 호출하는 두 액션으로 한정)은 워커 task 롤에 **직접** 부여되며(`agentcore_enabled` 게이팅의 agent Lambda `CostRead` Sid와 무관, 별도 최소 권한) `agentcore_enabled`를 요구하지 않는다. **단, `workers_enabled`만으로는 EBS 룰이 온전히 동작하지 않는다** — `ebs_unattached`는 `inventory_sync_runs`에 `ebs_volume`의 최신 성공 행이 있어야 하며, 이는 `steampipe_enabled=true`의 동기화 워커가 채운다. `steampipe_enabled=false`인 최소 구성에서는 이 룰이 매 실행마다 raise하고(엔진이 정직하게 `finops_runs.status='partial'`로 표면화 — 조용한 실패 아님), EC2/RDS 두 룰만 정상 동작한다. `finops_runs.ce_api_calls`는 CE 룰이 아직 없어 항상 0이다 — 컬럼은 향후 CE 기반 룰이 추가될 때를 위해 유지한다.
- **오탐 가드는 항목을 숨기지 않고 `needs_review`로 강등한다.** 현재 구현된 가드는 DR/컴플라이언스 보존 태그, Compute Optimizer의 관측 기간 부족(`lookBackPeriodInDays` < 14일), 인벤토리 데이터 staleness 세 가지다. Graviton/Spot 부적합·태그 커버리지 낮음 가드는 ADR 초안에만 있고 아직 구현되지 않았다 — 착수 시 이 절을 갱신한다. 가드 히트는 `guard_hits`에 기록되고 사용자가 확인할 수 있다.
- **엔진이 소유하는 우선순위는 없다** — API는 `monthly_savings_usd DESC NULLS LAST`로만 정렬한다. 별도 `priority` 필드는 향후 확장이다.
- 이 ADR이 고치는 부수 결함: ADR-012는 `cost-optimization-hub:*` 권한이 이미 부여돼 있다고 서술했지만 terraform에는 없었다(`ai.tf` `CostRead` Sid) — `aws_finops_mcp.py`의 COH 툴이 그 이후 상시 AccessDenied였다. 이 ADR과 같은 PR에서 권한을 추가해 문서-인프라 불일치를 해소한다.

## Consequences / 결과

### Positive / 긍정
- LLM 장애가 권장 기능 전체를 무력화하지 않는다 — 숫자와 근거는 항상 확정된 채로 렌더된다.
- CUR 부재를 감추지 않고 명시적으로 스코프 아웃해 "확인할 수 없는데 확인한 척"하는 실패를 피한다.
- 오탐 신고가 축적되어 다음 배치의 정확도 자산이 된다(`finops_exceptions`).
- ADR-012/terraform 드리프트가 이 PR에서 해소된다.

### Negative / Trade-offs
- CUR이 도입되기 전까지 팀 단위 지출 귀속, 미태깅 지출 정확한 금액, Bedrock 토큰 단가 룰은 구현되지 않는다(카탈로그에 등록만 됨).
- 일별 배치이므로 신선도는 초 단위가 아니다 — 카드마다 데이터 기준 시각을 표시해야 한다.
- 이번 PR은 Compute Optimizer(EC2/RDS) + EBS 두 축만 구현한다 — Cost Explorer/COH/Budgets 기반 룰, Graviton/Spot 부적합 가드, 태그 커버리지 가드, 엔진 소유 `priority`는 카탈로그/문서에만 존재하고 아직 실행되지 않는다(향후 확장). Cost Explorer 호출이 추가되면 건당 과금($0.01/건)이므로 `ce_api_calls` 계측을 다시 활성화해 상시 감시한다.

## 6 Pillars (비용 최적화 중심) / 6 Pillars (cost-optimization-focused)

- **Cost Optimization**: 상시 낭비(구조적 절감 기회)를 확정 금액과 근거를 갖춘 우선순위 목록으로 제공 — ADR-012의 "지출을 봤다"에서 "무엇을 줄일 수 있는지 안다"로 확장.
- **Security**: 새 write 경로 없음(ADR-005 무관, read-only 불변식 유지); IAM은 룰이 실제로 부르는 API로 최소화.
- **Reliability**: 배치가 요청 경로와 분리돼 있어 CE 지연/장애가 `/cost` 렌더를 막지 않는다; LLM 장애도 마찬가지.
- **Operational Excellence**: 룰 추가 = 파일 하나 + 카탈로그 등록 한 줄; 룰-실행기 짝 계약 테스트로 드리프트를 컴파일 타임에 막는다.
- **Performance Efficiency**: 없음(직접 관련 없음, 배치라 요청 지연에 영향 없음).
- **Sustainability**: 부수적 — 유휴 리소스 정리 권고는 전력 소비 절감과도 방향이 같다.

## References / 참고

- ADR-012 (Cost / FinOps) — 이 ADR이 확장하는 원본 도메인 결정
- ADR-005 (AWS 변경·자율 FROZEN) — 이 도메인은 그 범위 밖(신규 write 경로 없음)
- ADR-001/010 (v2 파운데이션, 인벤토리 리소스 모델) — `inventory_resources`가 근거의 리소스 축
- ADR-009 (비동기 워커 백본) — 배치 job 배선·job 타입 allowlist 규율
