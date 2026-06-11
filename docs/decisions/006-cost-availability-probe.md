# ADR-006: Cost Explorer 가용성 사전 감지 / Cost Explorer Availability Probe

## 상태: 승인됨 (v2 — 설치 시 판별 + 스냅샷 폴백 추가) / Status: Accepted (v2 — install-time detection + snapshot fallback)

> **정정 (v2 표기는 구 계획 기준 — 실현 안 됨)**: 위 "v2" 라벨은 pre-037 v2 계획 기준이다. 실현된 v2(ADR-037)는 Steampipe/`data/*.json`을 쓰지 않으므로 본 ADR의 메커니즘은 **v1 전용**이다. / **Correction (the "v2" label = the old pre-037 plan, never realized)**: the realized v2 (ADR-037) uses neither Steampipe nor `data/*.json`; this ADR's mechanism is **v1-only**.

## 컨텍스트 / Context
MSP가 Payer인 환경에서 Cost Explorer API 접근이 SCP에 의해 차단되거나 타임아웃됨.
현재 대시보드는 매 로딩마다 cost 쿼리 2개를 반복 실패시키며, Cost Explorer API 비용($0.01/건)도 발생.
v1의 런타임 probe 방식은 1시간 캐시 만료 후 다시 Steampipe 쿼리를 실행해야 하는 한계가 있었음.
(In MSP Payer environments, Cost Explorer API is blocked by SCP or times out.
v1's runtime probe still required Steampipe queries after 1-hour cache expiration.)

## 결정 / Decision

### Phase 1 — 런타임 probe (기존 유지)
- `checkCostAvailability()` probe 함수를 `steampipe.ts`에 유지
- `pool.connect()` 전용 커넥션 + `SET LOCAL statement_timeout = '10000'` (10초)
- `SELECT 1 FROM aws_cost_by_service_monthly LIMIT 1` 경량 probe
- 결과를 1시간 캐시 (`cache.set('cost:available', result, 3600)`)
- 대시보드/Cost 페이지에서 마운트 시 `GET /api/steampipe?action=cost-check` 호출
- `available=false` 시 cost 쿼리를 아예 전송하지 않음

### Phase 2 — 설치 시 MSP/Direct Payer 판별 (v2 추가)
- `scripts/02-setup-nextjs.sh` Step [4/4]에서 psql로 Cost Explorer 쿼리 시도
- 결과를 `data/config.json`에 `{"costEnabled": true|false}` 영구 저장
- `checkCostAvailability()`가 config를 **먼저** 확인 → `costEnabled=false`면 Steampipe 쿼리 없이 즉시 반환
- Sidebar에서 `GET /api/steampipe?action=config` → `costEnabled=false`면 Cost 메뉴 숨김
- Sidebar footer에 `Cost: ON/OFF` 토글 버튼 → `PUT /api/steampipe?action=config`로 런타임 전환 가능

### Phase 3 — 비용 데이터 스냅샷 폴백 (v2 추가)
- `src/lib/cost-snapshot.ts`: 비용 데이터를 `data/cost/YYYY-MM-DD.json`에 로컬 스냅샷 저장
- POST 배치 쿼리에서 cost 데이터 성공 시 자동 저장 (fire-and-forget)
- Cost 페이지: 라이브 쿼리 실패 시 `GET /api/steampipe?action=cost-snapshot`으로 마지막 스냅샷 로드
- "Showing cached data — Last fetched: ..." 배너로 stale 데이터 명시
- 180일 초과 스냅샷 자동 정리

## 근거 / Rationale
- 설치 시 1회 판별: MSP/SCP 상태는 계정 수준이므로 자주 변하지 않음. 매 요청 probe 불필요.
- config 우선 확인: MSP 환경에서 불필요한 Steampipe 커넥션/타임아웃 완전 제거
- 스냅샷 폴백: Direct Payer에서도 Steampipe 캐시(5분) 만료 후 일시적 장애 시 데이터 유지
- PUT API + Sidebar 토글: 설치 후에도 운영자가 언제든 Cost 기능 ON/OFF 가능
- `SET LOCAL`은 해당 트랜잭션에만 적용되어 다른 쿼리의 120초 타임아웃에 영향 없음

## 결과 / Consequences
- MSP 환경: 설치 시 자동 감지 → cost 관련 쿼리/메뉴/카드 완전 비활성화, API 비용 $0
- Direct Payer: probe 1회(10초 이내) + 1시간 캐시, 비용 데이터 스냅샷 자동 저장
- Direct Payer 일시 장애: 마지막 스냅샷으로 폴백하여 빈 화면 방지
- 디스크 사용: cost 스냅샷 일별 ~5-20KB × 180일 = ~3.6MB (무시 가능)
