# ADR-043: Optional Neptune Graph Substrate for Topology + DevOps Agent / 토폴로지·DevOps 에이전트 공용 Neptune 그래프 substrate (옵션)

<!-- Renumbered 040 → 043 on 2026-06-15 to resolve a merge collision: origin's ADR-040 (governed external knowledge/comms writes) holds 040. Co-agent panel (kiro + Gemini 3.1 Pro) unanimously chose to keep origin's cross-referenced 039/040/041 block intact and renumber leaf ADRs (login → 042, this → 043). -->


## Status / 상태

Accepted (2026-06-15) / 채택 (2026-06-15) — 멀티AI consensus 검증 완료. (1) ETL 게이트: Codex·Gemini·Kiro **만장일치 Option A**(Aurora 단일 소스). (2) ADR 게이트: Codex·Kiro NEEDS-CHANGES / Gemini ACCEPT → **4 MAJOR + 2 MINOR 전부 반영**: ① 결정을 Postgres-first로 재구성(Neptune은 연기 옵션), ② Loader mark-sweep 삭제/프루닝 추가, ③ Neptune VPC-only → VPC-resident openCypher MCP Lambda, ④ read-only는 분리된 IAM 롤(`neptune-db:ReadDataViaQuery`)이 1차 통제, ⑤ 비용 ~$115+/월 정정, ⑥ Loader 런타임=Node(TS 도출 모듈 공유). 설계 산출물은 본 ADR(브레인스토밍 다이어그램 `web/public/brainstorm/`은 임시).

이 ADR은 **그래프 substrate를 어떻게 채택/구성할지**를 고정한다. 구현 자체는 **flag-gated 옵션(P4)** 이며, 기본 경로는 현행 JS 토폴로지 빌더다.

## Context / 컨텍스트

v2 토폴로지는 `Route53 → CloudFront → ALB/NLB → TargetGroup → EC2/EKS-pod/Lambda → RDS` 요청 흐름 그래프를, 동기화된 Aurora 인벤토리(`inventory_resources`)에서 **순수 JS 빌더**(`web/lib/flow-topology.ts`)로 매 페이지 조립한다. 현재 규모(수백 노드)엔 충분하다.

두 압력이 그래프 전용 substrate를 검토하게 했다:

1. **DevOps 에이전트 RCA** (ADR-032 read-only Triage/RCA, KEPT): "이 RDS 죽으면 영향 범위?", "이 CF 요청 경로 추적", "이 서브넷 의존 워크로드" 같은 **멀티홉 traversal**은 평면 인벤토리로는 도구를 여러 번 엮어야 하고, 그래프 질의 한 번이면 끝난다.
2. **토폴로지 규모화**: 관계가 늘면(Spec 2의 ip→EKS/ECS, →RDS, 향후 SG/IAM/subnet) 클라이언트 JS 조립이 한계에 다다른다.

단, 본 프로젝트는 **read-only 운영 대시보드 + 비용 보수 + flag-gated 규율 + do-not-over-build**(2026-06-11 고위험 ADR 번복) 기조다. Neptune은 상시 비용(Serverless도 **최소 1 NCU ≈ ~$0.16/NCU-hr → ~$115+/월**, 0으로 안 내려감 — Aurora SLv2의 auto-pause와 다름; 스토리지/IO 별도)과 새 ETL/운영 부담을 더한다. Postgres 엣지테이블 대비 기회비용이 작지 않다. 따라서 "상시 인프라"가 아니라 **연기된 옵션**이어야 한다.

## Decision / 결정

**Postgres 엣지테이블(Aurora 재사용)을 그래프 질의의 기본 경로로 삼고, Amazon Neptune Serverless는 `neptune_enabled`(count/flag, 기본 false) 게이트의 *연기된* 옵션 substrate로 문서화**한다. 즉 **지금 짓는 것은 Neptune이 아니다** — Postgres 엣지로 멀티홉 RCA가 부족함이 입증될 때 비로소 Neptune을 켠다(do-not-over-build 준수). 본 ADR은 그 Neptune 옵션을 켤 경우의 **구성을 미리 고정**한다. 게이트 OFF면 `terraform plan` = No changes / $0이고, 웹 토폴로지는 현 JS 빌더로 정상 동작한다(폴백).

Neptune 옵션을 켤 경우의 구성 세부:

1. **ETL — Aurora → Graph Loader 단일 파이프라인** (멀티AI 만장일치 Option A). full-rebuild = 초기 bulk, filtered = 증분 — **동일 코드, 필터만 다름**(별도 bulk 경로 불필요). 그래프 도출 로직은 **JS 토폴로지 빌더와 공유**(중복 구현 금지 — 드리프트 방지) → 따라서 **Loader 런타임 = Node/TS**(`web/lib`의 공유 도출 모듈 import; Python 에이전트 컨벤션과 다름, Terraform 패키징에 명시). **결정적 ID**: 노드/엣지 ID는 JS 빌더와 동일 키(예: `alb:${arn}`, `tg:${arn}`, `cf:${id}`)로 MERGE. **삭제/프루닝(필수)**: 각 Loader 실행에 `sync_run_id`(또는 sync 타임스탬프)를 모든 노드/엣지에 스탬프 → 실행 종료 시 **현재 run으로 스탬프되지 않은 노드/엣지를 mark-sweep 삭제**(사라진 RDS/EC2/pod이 그래프에 잔존해 RCA가 오답하지 않도록). upstream sync가 stale/누락이면 Loader는 **그 실행을 skip**(그래프를 0으로 지우지도, 프루닝하지도 않음 — 마지막 정상 스냅샷 유지).
2. **에이전트 질의 — VPC 내 openCypher MCP 도구 Lambda**. Neptune은 **VPC 전용**이라 AgentCore Gateway가 직접 도달 못 함 → Gateway 타깃 = **VPC-resident Lambda**가 Neptune **Reader Endpoint**를 질의. **read-only는 IAM이 1차 통제**: 에이전트 질의용 **별도 읽기전용 Neptune 롤**(`neptune-db:ReadDataViaQuery`만, write/delete 없음) — Loader의 write 롤과 분리. 변형 키워드 거부는 **방어선(2차)**, 쿼리 타임아웃/결과 cap 병행. UI는 같은 read-only 경로의 BFF `/api/graph`(선택 가속).
3. **그래프 모델** — 현 토폴로지 관계 재사용: 라벨 `{Route53, CloudFront, ALB, NLB, TargetGroup, EC2, Pod, Lambda, RDS, WAF}`, 엣지 `ROUTES_TO / ORIGIN / TARGETS / RUNS_ON / PROTECTED_BY` 등 + `confidence (observed|inferred)` 속성 보존. SG/IAM/subnet 관계는 후속 확장.
4. **신선도 노출** — UI·에이전트 응답 모두에 "데이터 age"(Aurora sync 시각) 배지/주석.
5. **Serverless 최소 NCU** — idle 비용 최소화. 프로비저닝드 미채택.

## Options Considered / 고려한 대안

### Substrate: Postgres 엣지테이블 (Aurora 재사용) — **chosen (now)**
- **Pros**: 추가 비용 ≈ $0; recursive CTE로 멀티홉 가능; 기존 Aurora 운영; 에이전트는 SQL 도구로 질의.
- **Cons**: 깊은 traversal은 CTE가 번거롭고, 그래프 질의 표현력은 Cypher만 못함.
- **위상**: **기본 경로.** Postgres 엣지로 멀티홉 RCA가 충분한지 먼저 검증.

### Substrate: Neptune Serverless (옵션) — **deferred / 연기된 옵션 (flag-gated)**
- **Pros**: 멀티홉 traversal 네이티브(Cypher); 에이전트 그래프 RCA 1급; UI 규모화 대비.
- **Cons**: 상시 비용(~$115+/월); 새 DB 티어 + Loader 운영.
- **위상**: Postgres CTE 불충분이 **입증될 때만** `neptune_enabled` opt-in. 본 ADR이 그 구성을 미리 고정(즉시 구현 아님). (do-not-over-build 준수)

### Substrate: 상시-on Neptune (기본 인프라) — **기각**
- read-only 대시보드에 상시 비용 강제 + do-not-over-build 기조 충돌.

### ETL: Steampipe → Neptune 직접 (B) — **기각** / 하이브리드 bulk=Steampipe·증분=Aurora (C) — **기각**
- 멀티AI 만장일치: 그래프 도출 로직 이중 구현 강제 → consistency-drift; "bulk = Loader 무필터 1회"라 단일 파이프라인이 bulk+증분을 모두 제공 → 두 번째 경로 불필요.

### 질의: Gremlin / 고정 캐타로그 도구 — **기각(openCypher 채택)**
- Gremlin은 에이전트 생성 난이도↑; 고정 캐타로그는 유연성↓. openCypher = 가독성 + 에이전트 친화 + read-only 가드 가능.

## Consequences / 결과

- **긍정**: 켰을 때 에이전트가 영향범위/의존성/요청경로를 그래프 질의 한 번으로 분석; UI 규모화 경로 확보; 기본 off라 비용/복잡도 0 유지; 도출 로직 공유로 UI/에이전트 단일 진실.
- **부정/리스크**:
  - **누적 staleness** (AWS→Steampipe→Aurora→Neptune 2홉) — sync 타임스탬프 스탬프 + age 배지 + stale 시 skip로 완화.
  - **변환 드리프트** (Loader vs JS 빌더) — 도출 로직 공유로 차단.
  - **read-only 위반 위험** (openCypher) — **IAM 1차 통제**(에이전트용 `neptune-db:ReadDataViaQuery`-only 롤, Loader write 롤과 분리) + 변형 키워드 거부(방어선) + 쿼리 cap.
  - **삭제 누락 → RCA 오답** — Loader mark-sweep 프루닝(현재 run 미스탬프 노드/엣지 삭제)으로 사라진 리소스 제거.
  - **VPC 도달성** — Neptune은 VPC 전용 → openCypher MCP 도구는 VPC-resident Lambda(Reader Endpoint).
  - **비용** — Serverless 최소 NCU, flag-gated.
- **관계**: ADR-032(read-only RCA)에 그래프 질의 능력을 더함. ADR-037(v2 파운데이션) count/flag 게이트 패턴 계승. 2026-06-11 번복 기조 준수(변형/자율 없음, 읽기 전용 진단).

## Implementation Sketch (P4, optional) / 구현 스케치 (P4, 옵션)

**먼저(now): Postgres 엣지테이블** — `web/lib/flow-topology.ts`의 관계 규칙을 공유 모듈로 추출, 동기화 시 `topology_edges`(노드/엣지 + sync 타임스탬프) materialize, recursive CTE + 에이전트 SQL 도구로 멀티홉 질의. 충분성 검증.

**옵션(deferred): Neptune** — `terraform/v2/foundation/neptune.tf`(전부 `neptune_enabled` 게이트): Neptune Serverless(min NCU, VPC, KMS) + **Graph Loader Lambda(Node/TS 런타임**, 공유 도출 모듈 import; Aurora 읽기 → openCypher MERGE by deterministic id → **run-id mark-sweep 프루닝**) + EventBridge(sync 후 트리거) + **VPC-resident openCypher MCP Lambda**(Reader Endpoint, **read-only `neptune-db:ReadDataViaQuery` 롤** — Loader write 롤과 분리) AgentCore Gateway 타깃 + BFF `/api/graph`. Postgres CTE 불충분 입증 시에만 활성화.
