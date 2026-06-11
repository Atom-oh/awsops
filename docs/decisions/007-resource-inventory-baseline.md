# ADR-007: 리소스 인벤토리 베이스라인 / Resource Inventory Baseline

## 상태: 승인됨 (v2 — 멀티라인 차트 + EBS 추적 추가) / Status: Accepted (v2 — multi-line chart + EBS tracking)

> **정정 (v2 표기는 구 계획 기준 — 실현 안 됨)**: 위 "v2" 라벨은 pre-037 v2 계획 기준이다. 실현된 v2(ADR-037)는 Steampipe/`data/*.json`을 쓰지 않으므로 본 ADR의 메커니즘은 **v1 전용**이다. / **Correction (the "v2" label = the old pre-037 plan, never realized)**: the realized v2 (ADR-037) uses neither Steampipe nor `data/*.json`; this ADR's mechanism is **v1-only**.

## 컨텍스트 / Context
리소스 수량 추이 추적이 필요: 용량 계획, 이상 탐지, 비용-리소스 상관 분석.
Cost Explorer 불가 시 리소스 변동으로 비용 증감 유추도 가능.
v1은 StatsCards 6개 + 개별 LineChart 4개로 제한된 자원만 표시하여 전체 자원 추이 파악이 어려웠음.
(Resource count trend tracking needed for capacity planning, anomaly detection, cost correlation.
v1 showed only 6 StatsCards + 4 individual LineCharts, limiting visibility into all resources.)

## 결정 / Decision

### 데이터 수집 (v1 유지 + v2 확장)
- `data/inventory/` 디렉토리에 일별 JSON 스냅샷 저장 (영구 보관, .gitignore 추가)
- 대시보드의 기존 쿼리 결과에서 리소스 수량 추출 — **추가 AWS API 호출 0건**
- 대시보드 POST 요청에 `saveInventory: true` 플래그 → 서버에서 백그라운드 저장
- 90일 초과 스냅샷 자동 정리

### v2 변경: EBS Volumes/Snapshots 추적 추가
- `secSummary` 쿼리에 `total_volumes`, `total_snapshots` 서브쿼리 2개 추가
- `resource-inventory.ts` RESOURCE_MAP에 `'EBS Volumes'`, `'EBS Snapshots'` 매핑 추가
- 기존 배치 쿼리 1개에 서브쿼리 추가이므로 **추가 커넥션 0개**
- 총 추적 자원: 16종 → 18종

### v2 변경: 인벤토리 페이지 리디자인
- **Before**: StatsCards 6개 (비용 관련 자원만) + 개별 LineChart 4개 (top 4만)
- **After**: 컴팩트 요약 바 (Resource Types / Total Count / 7d Net Change) + 멀티라인 통합 차트
- **Core Resources** (EC2, RDS, S3, EBS Volumes, Lambda): 차트에 기본 표시
- **Other Resources**: 토글 칩으로 선택 시 차트에 추가/제거
- 30d/90d 기간 전환 버튼
- 멀티라인 툴팁: 마우스 오버 시 해당 날짜의 모든 활성 자원 수량을 값 크기순 정렬 표시
- 25개 자원에 고유 색상 매핑
- DataTable, Cost Impact Estimation 섹션 유지

## 근거 / Rationale
- `/tmp/` 대신 `data/inventory/`: EC2 재부팅 시에도 90일 히스토리 유지 (장기 추이 분석 핵심)
- 추가 쿼리 0건: 대시보드가 이미 로딩하는 결과를 재활용하므로 성능/비용 영향 없음
- JSON 파일: SQLite 등 새 의존성 불필요, fs만으로 충분
- 멀티라인 차트: 모든 자원을 카드로 표시하면 화면을 과도하게 차지하므로, 통합 차트 + 토글로 대체
- EBS Volumes/Snapshots: 주요 스토리지 자원이나 기존에 보안 지표(Unencrypted EBS)만 추적하고 있었음
- Core/Other 분리: 주요 자원은 항상 보이고, 나머지는 필요 시 선택하여 비교 가능

## 결과 / Consequences
- 디스크 사용: 일별 ~2KB × 90일 = ~180KB (무시 가능)
- 대시보드 응답 시간: saveSnapshot은 fire-and-forget이므로 영향 없음
- 첫 방문 시 빈 히스토리 → "No history yet" 안내 표시
- 멀티라인 차트에서 스케일 차이가 큰 자원 (예: K8s Pods 200 vs NAT Gateway 2) 동시 표시 시 작은 값이 압축될 수 있음 — 사용자가 토글로 유사 스케일 자원끼리 비교하여 해결
