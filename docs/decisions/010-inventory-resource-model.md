# ADR-010: 인벤토리 · 리소스 모델 / Inventory · Resource Model

## 상태 / Status
**Accepted (2026-06-22) — consolidated.** consolidates: 003 (SCP 차단 컬럼 처리), 007 (리소스 인벤토리 베이스라인) amended 2026-09-02 (SCP-blocked hydrate-column rule: flat ban → risk-accept-and-disclose; `iam_role.attached_policy_arns` reintroduced — see §2) / 개정 2026-09-02 (SCP 차단 하이드레이트 컬럼 규칙 완화 — §2 참조).

## 컨텍스트 / Context

AWSops는 운영 대시보드로서 AWS 리소스 인벤토리를 수집·표시한다. 인벤토리 수집과 표시에는 두 가지 교차하는 관심사가 있다.
(AWSops, as an operations dashboard, collects and displays the AWS resource inventory. Inventory collection and display involve two intersecting concerns.)

1. **리소스 인벤토리 베이스라인** — 어떤 리소스 타입을 어떻게 수집·영속·표시하는가. v2에서는 flag-gated Steampipe Fargate sync가 결과를 Aurora `inventory_resources` 테이블로 적재하고, 타입 레지스트리가 표시 대상 리소스 타입을 정의한다. (구 ADR-007 v1 메커니즘 — `data/inventory/` JSON 스냅샷 + 대시보드 쿼리 재활용 — 은 ADR-037 v2가 Steampipe/`data/*.json`을 쓰지 않으므로 **v1 전용**이다.)
   (Resource inventory baseline — which resource types are collected, how they are persisted, and how they are displayed. In v2 a flag-gated Steampipe Fargate sync loads results into the Aurora `inventory_resources` table, and a type registry defines which resource types are surfaced. The legacy ADR-007 v1 mechanism — `data/inventory/` JSON snapshots + reusing dashboard query results — is **v1-only**, since the realized v2 (ADR-037) uses neither Steampipe `data/*.json` nor inventory JSON snapshots.)

2. **SCP 차단 컬럼 처리** — AWS Organizations의 서비스 제어 정책(SCP)이 특정 API 호출(예: `iam:ListMFADevices`, `lambda:GetFunction`)을 차단할 수 있다. 인벤토리 sync가 이런 컬럼을 하이드레이트하려다 실패하면 쿼리 전체가 실패하므로, 쿼리 견고성(query robustness)을 확보해야 한다.
   (SCP-blocked column handling — AWS Organizations Service Control Policies can block certain API calls (e.g. `iam:ListMFADevices`, `lambda:GetFunction`). If the inventory sync tries to hydrate such columns and fails, the entire query fails — so query robustness is required.)

## 결정 / Decision

### 1. 리소스 인벤토리 (현행 v2 메커니즘) / Resource inventory (current v2 mechanism)
- **타입 레지스트리** — 표시 대상 리소스 타입을 레지스트리로 정의하고, 이 레지스트리가 인벤토리 sync 대상과 네비게이션을 구동한다.
  (A **type registry** defines which resource types are surfaced; this registry drives both what the inventory sync collects and the navigation.)
- **flag-gated Steampipe Fargate sync → Aurora** — `steampipe_enabled` 플래그로 게이트된 Steampipe Fargate 워커가 인벤토리를 수집하여 Aurora `inventory_resources` 테이블로 적재한다(기본 false → $0). 라이브 쿼리는 별도로 AgentCore MCP Lambda 도구가 담당한다.
  (A `steampipe_enabled`-gated Steampipe Fargate worker collects inventory and loads it into the Aurora `inventory_resources` table (default false → $0). Live queries remain the responsibility of AgentCore MCP Lambda tools.)
- **2026-08-31 rollout note (ADR-021)** — Phase 1의 전역 limiter, sync backpressure, durable last-success ledger, `partial` 상태, stale threshold는 저장소에 구현됐다. 성공한 0-row 실행도 `last_success_at`/`last_success_row_count`에 남고, 계정 일부가 도달 불가하면 last-good row를 보존한 채 `partial`로 기록한다. 이 변경을 수행한 에이전트는 apply를 실행하지 않았고 실제 배포는 controller 확인 대상이다. **현재 ops gateway의 제한된 Aurora `inventory-read-target`과 direct domain inventory/configuration target이 공존**하며, `query_inventory`/`inventory_summary`는 `healthy|degraded|stale|unavailable` freshness를 공개한다. Phase 2는 domain-aware Aurora coverage를 확장하고 parity 뒤 direct target을 retirement한다. Aurora-only는 아직 live가 아니다.
  (**2026-08-31 rollout note (ADR-021)** — Phase 1's global limiter, sync backpressure, durable last-success ledger, `partial` status, and stale threshold are implemented in the repository. A successful zero-row run remains in `last_success_at`/`last_success_row_count`; an unreachable expected account preserves last-good rows and records `partial`. The agent making this change did not run apply; actual deployment is a controller verification item. **The ops gateway's limited Aurora `inventory-read-target` currently coexists with direct domain inventory/configuration targets**, and `query_inventory`/`inventory_summary` disclose `healthy|degraded|stale|unavailable` freshness. Phase 2 expands domain-aware Aurora coverage and retires direct targets after parity. Aurora-only is not live.)

### 2. SCP 차단 컬럼 처리 (쿼리 견고성) / SCP-blocked column handling (query robustness)
- `aws.spc`(Steampipe 커넥션 설정)에서 테이블 수준 오류를 위한 `ignore_error_codes`를 설정한다.
  (Set `ignore_error_codes` in `aws.spc` (the Steampipe connection config) for table-level errors.)
- **리스트 쿼리에서 SCP 차단 컬럼을 제거**한다(기본 규칙 — 2026-09-02 개정으로 명시적 위험 수용 예외 허용, 아래 개정 항목 참조) — `mfa_enabled`, `attached_policy_arns`, 리스트에서의 `tags` 등. 리스트는 다수 리소스를 하이드레이트하므로 단일 차단 컬럼이 전체 쿼리를 실패시킨다.
  (**Remove SCP-blocked columns from list queries** — `mfa_enabled`, `attached_policy_arns`, `tags` in lists, etc. Lists hydrate many resources, so one blocked column fails the whole query.)
- **상세 쿼리에서는 차단 컬럼을 유지**한다 — 단일 리소스 조회라 실패 가능성이 낮다.
  (**Keep blocked columns in detail queries** — single-resource lookups, lower failure probability.)
- **(개정 2026-09-02)** 이 규칙은 **절대 금지가 아니라 위험-공지 규칙**으로 완화된다 — 단, 실패 시맨틱을 정확히 공지한다: SCP가 하이드레이트 API를 차단하면 Steampipe 쿼리 예외로 **해당 타입의 run 전체가 `failed`로 기록된다**(계정별 `partial` 강등이 아님 — Steampipe 집계 쿼리는 계정 단위로 분리되지 않는다). 이때도 프루닝은 건너뛰어 **모든 계정의 last-good 행이 보존·동결**된다(ADR-021의 last-good 보존과 freshness 공개는 그대로 적용 — `query_inventory`가 stale/degraded를 노출). 이 전 계정 동결 blast radius를 수용 가능한 위험으로 받아들이고 `iam_role` 리스트에 `attached_policy_arns`를 재도입한다(S3 상세의 접근 role 드릴다운용 — per-row `ListAttachedRolePolicies` 하이드레이트; S3 상세의 접근 role 섹션이 run status를 표시해 실패 run 아래에서 확정 결론을 내리지 않는다(일반 iam_role 인벤토리 페이지의 run-status 노출은 후속 과제)). (참고: `iam_user` 리스트의 `mfa_enabled`는 본 개정 전부터 존재하던 선례.)
  (**Amended 2026-09-02** — softened from a hard ban to a risk-disclosure rule, with the failure semantics stated PRECISELY: an SCP-blocked hydrate raises a Steampipe query exception that records the ENTIRE type run `failed` (NOT a per-account `partial` — aggregator queries are not account-isolated). Pruning is skipped, so last-good rows for ALL accounts are preserved but frozen (ADR-021's last-good preservation and freshness disclosure still apply — `query_inventory` surfaces stale/degraded). Accepting that whole-type blast radius as the disclosed risk, `attached_policy_arns` is reintroduced on the `iam_role` list for the S3 detail's access-role drill-down (a per-row `ListAttachedRolePolicies` hydrate; the S3 detail's access-role section surfaces the run status and never draws conclusive results under a failed run (surfacing run status on the general iam_role inventory page is a follow-up)). Note: `mfa_enabled` on the `iam_user` list predates this amendment.)

차단된 API 목록 / Blocked APIs found:
(2026-09-02 개정 관련: `iam:ListAttachedRolePolicies` / `aws_iam_role.attached_policy_arns` — 차단 시 위 개정의 전 계정 동결 시맨틱 적용 / amendment-related: `iam:ListAttachedRolePolicies` on `aws_iam_role.attached_policy_arns` — the amendment's whole-type-freeze semantics apply when blocked)

| 컬럼 (Column) | API | 테이블 (Table) |
|---|---|---|
| `mfa_enabled` | `iam:ListMFADevices` | `aws_iam_user` |
| `attached_policy_arns` | `iam:ListAttachedUserPolicies` | `aws_iam_user` |
| `tags` (리스트에서 / in list) | `lambda:GetFunction` | `aws_lambda_function` |

## 결과 / Consequences

### Positive
- 타입 레지스트리 기반 sync로 표시 리소스 타입을 한 곳에서 관리. SCP 차단 컬럼을 리스트에서 제거하면 sync가 부분 차단 환경에서도 견고하게 동작 — 단, 2026-09-02 개정으로 명시적 위험 수용 하에 하이드레이트 컬럼을 유지하는 예외가 허용된다(§2 개정 참조: `iam_role.attached_policy_arns`).
  (Registry-driven sync centralizes surfaced types; removing SCP-blocked columns from lists keeps the sync robust under partially-restricted environments — with the 2026-09-02 amendment permitting exceptions under explicit risk acceptance (see the §2 amendment: `iam_role.attached_policy_arns`).)
- `steampipe_enabled` 게이트로 기본 비활성($0), 활성화 시에만 Fargate sync 비용 발생.
  (`steampipe_enabled` gate keeps it off by default ($0); Fargate sync cost only accrues when enabled.)

### Negative
- SCP가 컬럼을 차단하는 환경에서는 일부 대시보드 카드(특히 IAM MFA 관련 지표)가 0 또는 결측으로 표시될 수 있다.
  (Under SCP-blocking environments, some dashboard cards — notably IAM MFA metrics — may show 0 or missing values.)
- 신규 컬럼 하이드레이트 오류 발생 시 해당 컬럼을 리스트 SQL에서 제거하거나, 2026-09-02 개정 경로로 위험을 수용·공지한다. 수용 시 blast radius: SCP 차단 하이드레이트는 해당 타입 run 전체를 failed로 만들고 전 계정 last-good 행을 동결한다(소비 UI가 run 상태를 표기).
  (New column hydrate errors require either removing the column from list SQL or accepting+disclosing the risk per the 2026-09-02 amendment. Accepted blast radius: an SCP-blocked hydrate fails the whole type run and freezes last-good rows for ALL accounts — consuming UIs surface the run status.)

### 해결된 갭 / Resolved gap
- **parity-12: ECS 서비스 차원 구현됨.** `sync_lambda.py`의 `ecs_service` 수집은 cluster/service 복합 키와 desired/running/pending count, launch type을 Aurora에 적재하며 v2 inventory registry/UI가 이를 사용한다.
  (**parity-12: ECS service dimension implemented.** `sync_lambda.py` now materializes `ecs_service` with a cluster/service composite key, desired/running/pending counts, and launch type for the v2 inventory registry/UI.)

## 6 기둥 / Six Pillars (Well-Architected)
- **운영 우수성 (Operational Excellence)** — 타입 레지스트리로 인벤토리 수집·네비게이션을 단일 출처에서 구동하며, `ecs_service`를 포함한 현재 타입 계약을 Aurora에 영속한다.
  (The type registry drives collection/navigation from a single source and persists the current contract, including `ecs_service`, in Aurora.)
- **보안 (Security)** — read-only 인벤토리 수집. SCP 차단은 권한 경계를 존중하며, 차단 컬럼 제거는 우회가 아니라 부분 데이터로의 graceful degradation.
  (Read-only collection. SCP blocking respects permission boundaries; dropping blocked columns is graceful degradation to partial data, not a bypass.)
- **신뢰성 (Reliability)** — `ignore_error_codes` + 리스트 컬럼 제거로 부분 차단 환경에서도 sync가 전체 실패 없이 완료. 2026-09-02 개정으로 유지되는 하이드레이트 컬럼(`iam_role.attached_policy_arns`)은 예외 — SCP 차단 시 그 타입 run이 failed가 되며 last-good 동결로 격리된다.
  (`ignore_error_codes` plus list-column removal lets the sync complete without total failure under partial blocking. Hydrate columns retained under the 2026-09-02 amendment (`iam_role.attached_policy_arns`) are the exception — an SCP block fails that type's run, isolated by the last-good freeze.)
- **성능 효율성 (Performance Efficiency)** — Fargate sync는 비동기 워커 티어에서 수행되어 thin-BFF 부하와 분리.
  (Fargate sync runs in the async worker tier, decoupled from thin-BFF load.)
- **비용 최적화 (Cost Optimization)** — `steampipe_enabled` 기본 false → 비활성 시 $0. 인벤토리는 Aurora에 영속되어 반복 라이브 쿼리 회피.
  (`steampipe_enabled` default false → $0 when off. Inventory persisted in Aurora avoids repeated live queries.)
- **지속가능성 (Sustainability)** — flag-gated 수집으로 불필요한 상시 폴링 제거. 적재는 Aurora 단일 테이블로 통합.
  (Flag-gated collection eliminates needless constant polling; loading consolidates into a single Aurora table.)

---

> 정정 노트 / Correction note: 구 ADR-007의 "v2" 라벨(멀티라인 차트 + EBS 추적, `data/inventory/` JSON 스냅샷)은 pre-037 계획 기준으로 실현되지 않았으며 본 ADR의 현행 v2 메커니즘과 무관하다. 구 ADR-007 v1 메커니즘은 v1 전용으로 보존된다.
> (The legacy ADR-007 "v2" label (multi-line chart + EBS tracking, `data/inventory/` JSON snapshots) reflects the never-realized pre-037 plan and is unrelated to this ADR's current v2 mechanism. The legacy ADR-007 v1 mechanism is preserved as v1-only.)
