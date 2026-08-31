# ADR-021: 쿼터 격리 인벤토리 읽기 / Quota-Isolated Inventory Reads

## 상태 / Status

**채택됨 (2026-08-31) — 목표 아키텍처 승인, Phase 1 저장소 구현 완료. 이 변경을 수행한 에이전트는 Terraform apply를 실행하지 않았으며, controller의 실제 배포 상태는 별도로 확인해야 한다.**
**Accepted (2026-08-31) — target architecture accepted, Phase 1 repository implementation complete. The agent making this change did not run Terraform apply; the controller's actual deployment status must be verified separately.**

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

**현재는 ops gateway의 제한된 Aurora `inventory-read-target`과 직접 domain AgentCore inventory/configuration API target이 함께 존재한다.** `query_inventory`와 `inventory_summary`는 threshold 기반 type별 freshness를 공개하지만, Aurora-only domain coverage는 아직 live가 아니다. Phase 2는 이 기존 Aurora reader를 도메인별로 확장하고 parity 뒤 직접 target을 retirement한다.
**Current truth is coexistence: a limited Aurora-backed `inventory-read-target` is already present on the ops gateway alongside direct domain AgentCore inventory/configuration API targets.** `query_inventory` and `inventory_summary` disclose threshold-based per-type freshness, but Aurora-only domain coverage is not live. Phase 2 expands the existing reader by domain and retires direct targets after parity.

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

Steampipe 시작/재생성 시 `steampipe_limiter_config` JSON 이벤트가 effective `max_concurrency`, `bucket_size`, `fill_rate`를 기록한다. Phase 1 sync Lambda는 `inventory_sync_dispatch`, `inventory_sync_complete`, `inventory_sync_busy`, `inventory_sync_failed` JSON 이벤트를 남긴다. 모든 정상 terminal 이벤트에는 `degraded`, `throttled`, `resource_type`, `elapsed_ms`가 있고, 성공에는 `row_count`, `freshness=healthy`, `age_minutes=0`, 실패에는 `error_category`와 안전하게 정리된 오류 유형이 있다.

At Steampipe startup/regeneration, `steampipe_limiter_config` records the effective `max_concurrency`, `bucket_size`, and `fill_rate`. The Phase 1 sync Lambda emits `inventory_sync_dispatch`, `inventory_sync_complete`, `inventory_sync_busy`, and `inventory_sync_failed`. Every normal terminal event includes `degraded`, `throttled`, `resource_type`, and `elapsed_ms`; success also includes `row_count`, `freshness=healthy`, and `age_minutes=0`, while failure includes an `error_category` and safely classified error type.

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
