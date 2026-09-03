# ADR-021: 쿼터 격리 인벤토리 읽기 / Quota-Isolated Inventory Reads

## 상태 / Status

**채택됨 (2026-08-31) — 목표 아키텍처 승인, Phase 1 저장소 구현 완료. 이 변경을 수행한 에이전트는 Terraform apply를 실행하지 않았으며, controller의 실제 배포 상태는 별도로 확인해야 한다. 개정 2026-09-02: 운영 관측 계약 확장 — `inventory_sync_hydrate_fallback` 이벤트 추가, `unknown_attribute_count` 정의 확장(하이드레이트 폴백의 일시 오류 포함), partial `inventory_sync_complete` 이벤트에 `unknown_attribute_count` 필드 추가(§운영 관측 참조). 2026-09-03: 수동 전체 타입 dispatch 문서화 — 대시보드의 관리자 전용 '전체 동기화'는 기존 refresh 라우트의 type=all 특례로 sync Lambda에 15분 스케줄과 동일한 `{type:"all"}` 페이로드를 Event invoke(기존 envelope 내: reserved concurrency·타입별 advisory lock·async 재시도 0·event age 900s; 서버 측 cooldown 없음 — 후속 추적).**
**Accepted (2026-08-31) — target architecture accepted, Phase 1 repository implementation complete. The agent making this change did not run Terraform apply; the controller's actual deployment status must be verified separately. Amended 2026-09-02: observability contract extended — new `inventory_sync_hydrate_fallback` event, `unknown_attribute_count` definition extended (hydrate-fallback transients included), `unknown_attribute_count` added to the partial `inventory_sync_complete` event (see §Operational observability). 2026-09-03: manual ALL-TYPES dispatch documented — the dashboard's admin-only Sync-all POSTs the existing refresh route with `type=all`, which Event-invokes the sync Lambda with the SAME `{type:"all"}` payload the 15-minute schedule sends (in-envelope: reserved concurrency, per-type advisory locks, zero async retries, 900s event age; no server-side cooldown — a tracked follow-up).**

이 ADR은 ADR-005를 완화하지 않는다. AWS 리소스 변경과 자율 조치는 계속 FROZEN이며, 이 결정의 모든 수집·조회 경로는 읽기 전용이다.
This ADR does not relax ADR-005. AWS-resource mutation and autonomy remain FROZEN; every collection and read path in this decision is read-only.

## 컨텍스트 / Context

읽기 전용 IAM은 변경을 막지만 가용성 영향을 막지는 않는다. AgentCore MCP Lambda가 AWS 제어 영역 API를 직접 반복 호출하면, 배포·확장·운영 시스템과 계정·리전·서비스·작업별 쿼터를 경쟁할 수 있다. 다중 채팅 요청이나 라우트 fan-out은 한 번의 사용자 요청보다 많은 하위 API 호출을 만들 수 있으며, 그 결과 throttling이 프로덕션 운영에 영향을 줄 수 있다.

Read-only IAM prevents mutation, not availability impact. Repeated direct AWS control-plane calls from AgentCore MCP Lambdas can compete with deployment, scaling, and operations systems for account-, Region-, service-, and operation-scoped quotas. Multi-route fan-out can turn one user request into many downstream calls and cause production-impacting throttling.

## 결정 / Decision

완전한 롤아웃의 선택된 구조는 **쿼터 제한 Steampipe → Aurora → 도메인 AgentCore MCP** 이다. Steampipe는 인벤토리를 제한된 배치로 수집하고 Aurora가 인벤토리·구성 읽기의 내구성 있는 소스가 된다. Phase 3까지 완료된 뒤 AWS에 라이브로 남는 예외는 엄격한 admission budget, 시간 범위, 결과 수를 적용한 **CloudWatch Metrics와 CloudWatch Logs** 뿐이다.

The selected end-state is **quota-limited Steampipe → Aurora → domain AgentCore MCP**. Steampipe collects inventory through a bounded batch, and Aurora becomes the durable source for inventory/configuration reads. After Phase 3 is complete, the only live AWS exceptions are bounded **CloudWatch Metrics and CloudWatch Logs** operations with strict admission budgets, time ranges, and result limits.

Aurora 인벤토리가 오래되었거나 사용할 수 없을 때는 라이브 AWS API로 조용히 fallback하지 않는다. Phase 2의 Aurora 도구는 마지막 성공 동기화 시각을 포함한 `stale` 또는 `unavailable` 결과를 반환해야 한다.
When Aurora inventory is stale or unavailable, it must not silently fall back to a live AWS API. Phase 2 Aurora tools must return `stale` or `unavailable` with the most recent successful-sync timestamp.

### 현재 진실과 롤아웃 / Current truth and rollout

| Phase | 상태 / Status | 범위 / Scope |
|---|---|---|
| 1 | **저장소 구현 완료; 이 변경은 apply 미실행, 실제 배포는 controller 확인 필요** / **Repository implementation complete; this change did not apply, controller deployment verification required** | Steampipe 전역 limiter, sync Lambda backpressure, 15분 비동기 이벤트 만료, 구조화 lifecycle/limiter 로그, configurable stale threshold, 예약·수동 refresh의 동일한 bounded 경로 |
| 2 | **확장·cutover pending** / **Expansion and cutover pending** | 이미 ops gateway에 존재하는 제한된 `inventory-read-target`을 network/container/data/security 도메인 계약으로 확장하고, parity 뒤 직접 inventory/configuration target을 catalog에서 retirement |
| 3 | **미구현·미배포** / **Not implemented or deployed** | CloudTrail·cost·FinOps의 예약 Aurora cache 및 해당 라이브 target retirement |

**현재는 ops gateway의 제한된 Aurora `inventory-read-target`과 직접 domain AgentCore inventory/configuration API target이 함께 존재한다.** `query_inventory`와 `inventory_summary`는 durable last-success와 현재 row의 가장 오래된 `captured_at`을 사용해 type별 `healthy|degraded|stale|unavailable`을 공개하지만, Aurora-only domain coverage는 아직 live가 아니다. Phase 2는 이 기존 Aurora reader를 도메인별로 확장하고 parity 뒤 직접 target을 retirement한다.
**Current truth is coexistence: a limited Aurora-backed `inventory-read-target` is already present on the ops gateway alongside direct domain AgentCore inventory/configuration API targets.** `query_inventory` and `inventory_summary` use durable last-success metadata and the oldest current row `captured_at` to disclose per-type `healthy|degraded|stale|unavailable`; Aurora-only domain coverage is not live. Phase 2 expands the existing reader by domain and retires direct targets after parity.

`inventory_sync_runs`는 current-run singleton row이지만 `last_success_at`과 `last_success_row_count`를 별도로 보존한다. 모든 expected host/target account가 도달 가능해야 full `succeeded`이며, 진짜 0-row도 full success로 기록된다. expected account 일부가 도달 불가하면 last-good row를 삭제하지 않고 current status를 `partial`로 기록하며 durable last-success를 전진시키지 않는다.
`inventory_sync_runs` remains a singleton current-run row but separately preserves `last_success_at` and `last_success_row_count`. Full `succeeded` requires every expected host/target account to be reachable, including a genuine zero-row result. If an expected account is unreachable, the sync preserves its last-good rows, records current status `partial`, and does not advance durable last-success.

`unknown_attribute_count`는 steady-state denial로 blind 처리된 attribute read 수를 기록한다. 이 값은 공개되는 freshness를 degrade시키지만(`succeeded` + unknowns > 0 → `degraded`) `last_success_at` 전진이나 pruning을 막지 않는다. 반면 transient 실패로 degrade된 rec은 upsert하지 않고 건너뛴다 — partial run이 last-known-good row 내용을 덮어쓰는 일은 없어야 한다.
`unknown_attribute_count` records how many attribute reads were blinded by steady-state denials. It degrades the DISCLOSED freshness (`succeeded` with unknowns > 0 reports `degraded`) without blocking `last_success_at` or pruning. Transiently degraded recs are skipped rather than upserted, so a partial run never overwrites last-known-good row content.

### Migration-gated rollout / Migration 선행 롤아웃

Terraform이 `inv-sync` Lambda source를 소유·패키징하며 새 running UPSERT는
`inventory_sync_runs.run_token`을 요구한다. 따라서 기존 활성 환경은 새 Steampipe
이미지를 roll 없이 먼저 push한 뒤 현재 foundation outputs로 `make migrate`를 실행하고,
그 후에만 Lambda/task definition을 갱신하는 saved plan을 생성·검토·적용한다. 최초
활성화는 foundation/Aurora를 `steampipe_enabled=false`로 먼저 만들고 migration을
적용한 뒤 Steampipe image를 생성/push하고, 마지막 saved-plan apply에서만
`steampipe_enabled=true`를 활성화한다. ECR이 아직 없으면 migration 뒤 repository-only
bootstrap plan으로 ECR만 만들 수 있지만 Lambda/event rule은 만들면 안 된다.

Terraform owns and packages the `inv-sync` Lambda source, and the new running UPSERT requires
`inventory_sync_runs.run_token`. An existing enabled environment therefore pushes the new
Steampipe image without rolling it, runs `make migrate` using the current foundation outputs, and
only then creates/reviews/applies the saved plan that updates the Lambda/task definition. A
first-time enablement creates the foundation/Aurora with `steampipe_enabled=false`, migrates first,
creates/pushes the Steampipe image, and enables `steampipe_enabled=true` only in the final saved-plan
apply. If the ECR repository does not yet exist, a repository-only bootstrap plan may create it
after migration, but it must not create the Lambda/event rule.

`make deploy`는 web ECS rollout만 수행하므로 이 Lambda 순서의 대체물이 아니다. 이 순서를
지킬 수 없으면 새 Lambda를 배포하지 않는다.
`make deploy` rolls only the web ECS service and is not a substitute for this Lambda ordering. If
this order cannot be satisfied, do not deploy the new Lambda.

### Phase 1 기본값 / Phase 1 defaults

Phase 1은 `steampipe_enabled=false`이면 인프라를 만들지 않는 기존 flag gate를 유지한다. 활성화 시 다음 보수적 기본값을 사용한다.
Phase 1 preserves the existing zero-resource gate when `steampipe_enabled=false`. When enabled, it uses these conservative defaults.

| 설정 / Setting | 기본값 / Default | 검증 범위 / Validation |
|---|---:|---|
| `steampipe_aws_max_concurrency` | 4 | 정수 1–20 / integer 1–20 |
| `steampipe_aws_bucket_size` | 4 | 정수 1–40 / integer 1–40 |
| `steampipe_aws_fill_rate` | 2 requests/s | 0.1–20 requests/s |
| `steampipe_sync_reserved_concurrency` | 4 | 정수 1–20 / integer 1–20 |
| `inventory_stale_after_minutes` | 30 minutes | 정수 1–1440 / integer 1–1440 |
| scheduled sync | 15 minutes | EventBridge `rate(15 minutes)` |
| async event age | 900 seconds | 15-minute schedule window |
| async retries | 0 | delayed events expire rather than retry-storm |

렌더된 `aws.spc`에는 scope가 없는 `awsops_global` limiter가 정확히 하나 있어 모든 연결·계정·리전에서 같은 upstream 예산을 공유한다. Lambda reserved concurrency는 AWS API 쿼터의 대체가 아니라 fan-out이 Steampipe query session을 과도하게 늘리지 않게 하는 backpressure다.
Generated `aws.spc` contains exactly one unscoped `awsops_global` limiter so every connection, account, and Region shares one upstream budget. Lambda reserved concurrency is not a substitute for AWS API quota control; it backpressures fan-out so it cannot create unbounded Steampipe query sessions.

## 결과 / Consequences

- 프로덕션 availability를 보호하는 제어 지점을 인벤토리 수집 경계에 둔다.
  (The inventory collection boundary becomes a production-availability control point.)
- 수동 refresh와 예약 refresh가 같은 비동기·예약 동시성 경로를 사용한다.
  (Manual and scheduled refreshes use the same asynchronous reserved-concurrency path.)
- 제한된 ops Aurora reader가 이미 존재하지만 direct domain target의 쿼터 노출은 Phase 2 retirement까지 남는다.
  (A limited ops Aurora reader already exists, but quota exposure from direct domain targets remains until Phase 2 retirement.)
- 데이터 결손을 라이브 fallback으로 감추지 않으므로 freshness와 미가용 상태가 사용자에게 드러난다.
  (Freshness and unavailability remain visible instead of being hidden by a live fallback.)

## 운영 관측 / Operational observability

Steampipe 시작/재생성 시 `steampipe_limiter_config` JSON 이벤트가 effective `max_concurrency`, `bucket_size`, `fill_rate`를 기록한다. Phase 1 sync Lambda는 `inventory_sync_dispatch`, `inventory_sync_complete`, `inventory_sync_busy`, `inventory_sync_failed` JSON 이벤트를 남긴다. Full success의 `inventory_sync_complete`는 `degraded=false`, `freshness=healthy`, `age_minutes=0`이다. 계정 일부가 도달 불가한 partial completion은 같은 complete event에 `degraded=true`, `freshness=degraded`, `age_minutes=null`, `unreachable_account_count`, `unknown_attribute_count`(2026-09-02 추가 — 하이드레이트 폴백이 partial과 겹칠 수 있음)를 기록하며 account ID는 로그에 쓰지 않는다. 실패에는 `error_category`와 안전하게 정리된 오류 유형만 있고 raw error text는 없다.

At Steampipe startup/regeneration, `steampipe_limiter_config` records the effective `max_concurrency`, `bucket_size`, and `fill_rate`. The Phase 1 sync Lambda emits `inventory_sync_dispatch`, `inventory_sync_complete`, `inventory_sync_busy`, and `inventory_sync_failed`. Full success emits `inventory_sync_complete` with `degraded=false`, `freshness=healthy`, and `age_minutes=0`. An unreachable-account partial completion uses the same complete event with `degraded=true`, `freshness=degraded`, `age_minutes=null`, `unreachable_account_count`, and `unknown_attribute_count` (added 2026-09-02 — a hydrate fallback can coincide with a partial); account IDs are never logged. Failures include only a safe `error_category`/type, not raw error text.

(2026-09-02 추가 — ADR-010 개정 연동) `inventory_sync_hydrate_fallback` — 하이드레이트 컬럼 쿼리(현재 `iam_role.attached_policy_arns`)가 실패해 하이드레이트-프리 폴백으로 완료된 run을 기록한다. 이 run은 `succeeded`이되 `unknown_attribute_count`(행 수)로 blind 상태가 공개되어 본 ADR의 `succeeded+unknowns→degraded` freshness 채널을 그대로 탄다. event의 `remedy`는 원인별이다: statement timeout → 리미터 `fill_rate` 상향; SCP/IAM 거부 → `iam:ListAttachedRolePolicies` 권한 부여.
(Added 2026-09-02, paired with the ADR-010 amendment) `inventory_sync_hydrate_fallback` records a run completed via the hydrate-free fallback (currently `iam_role.attached_policy_arns`): the run is `succeeded` but discloses the blind spot through `unknown_attribute_count` (the row count), riding this ADR's `succeeded+unknowns→degraded` freshness channel. The event's `remedy` is cause-specific: statement timeout → raise the limiter `fill_rate`; SCP/IAM denial → grant `iam:ListAttachedRolePolicies`. 정의 확장: 본 ADR의 `unknown_attribute_count`는 원래 steady-state denial blind를 세는 값이지만, 하이드레이트 폴백 경로는 **일시 오류를 포함한 모든** 하이드레이트 실패를 succeeded+unknowns로 라우팅한다 — 다음 주기 sync가 성공하면 카운트는 자연히 0으로 돌아가므로 일시 오류는 한 주기의 degraded 공개로 자기-치유된다(의도된 확장). / Definitional extension: this ADR's `unknown_attribute_count` originally counted steady-state denial blinds; the hydrate-fallback path deliberately routes ANY hydrate failure — transients included — into succeeded+unknowns, and a transient self-heals as the next cycle's successful sync returns the count to 0 (one cycle of disclosed degraded, by design).

## 6 기둥 / Six Pillars

- **신뢰성 / Reliability:** shared limiter와 backpressure가 읽기 burst의 throttling 영향을 줄인다.
- **운영 우수성 / Operational Excellence:** lifecycle log와 Aurora sync ledger로 sync 결과와 freshness를 추적한다.
- **성능 효율성 / Performance Efficiency:** inventory API work를 배치로 격리하고 향후 Aurora read로 요청 경로를 안정화한다.
- **비용 최적화 / Cost Optimization:** `steampipe_enabled` 기본 off와 보수적 한도로 불필요한 실행을 피한다.
- **보안 / Security:** 새 mutation 권한·도구·자율 경로가 없으며 ADR-005 FROZEN을 유지한다.

## 참고 / References

- Approved design: `docs/superpowers/specs/2026-08-31-steampipe-quota-safe-aurora-mcp-design.md`
- Operator procedure: `docs/runbooks/steampipe-quota-and-staleness.md`
- ADR-001 (v2 foundation), ADR-005 (mutation/autonomy FROZEN), ADR-010 (inventory model)
