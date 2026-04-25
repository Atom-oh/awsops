# ADR-017: Cache Warmer Prewarming Strategy / 캐시 워머 프리워밍 전략

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops dashboards each aggregate 10-30 Steampipe queries that sweep across 380+ AWS tables. A cold pg Pool query against the Steampipe FDW can take 2-10 seconds per table, so a user opening the dashboard after a period of inactivity would face a multi-second wait while `runQuery()` re-fetched everything from the AWS API. Relying solely on on-demand caching (`node-cache` with a 300-second TTL, see `src/lib/steampipe.ts`) does not solve the problem because the very first request after a TTL expiry still pays the full cost.

AWSops 대시보드는 각 페이지마다 10-30개의 Steampipe 쿼리를 실행하며 380개 이상의 AWS 테이블을 조회한다. pg 풀이 차가운 상태에서 Steampipe FDW를 통한 쿼리는 테이블당 2-10초가 소요되므로, 유휴 상태 이후 대시보드를 여는 사용자는 `runQuery()`가 AWS API에서 데이터를 다시 가져오는 동안 수 초를 기다려야 한다. 요청 기반 캐싱(`node-cache`, 300초 TTL, `src/lib/steampipe.ts` 참조)만으로는 TTL 만료 직후 첫 요청이 전체 비용을 그대로 지불해야 하므로 이 문제를 해결하지 못한다.

Additional constraints uncovered during operation:
- CloudWatch metric tables (`aws_cloudwatch_metric_*`) issue slow AWS API calls via the Steampipe FDW and frequently leave zombie connections behind, exhausting the pg Pool (max 10 slots).
- Next.js production boot must not block on Steampipe: Steampipe may be restarting after an account add, or running on a separate instance.
- The warmer runs inside the same process as user traffic, so it must not starve `batchQuery()` slots allocated to live requests.

운영 중에 발견된 추가 제약:
- CloudWatch 메트릭 테이블(`aws_cloudwatch_metric_*`)은 Steampipe FDW를 통해 느린 AWS API 호출을 수행하며 좀비 커넥션을 남기는 경우가 많아 pg 풀(max 10)을 고갈시킨다.
- Next.js 프로덕션 부팅은 Steampipe에 블로킹되면 안 된다. 계정 추가 후 Steampipe가 재시작 중이거나 별도 인스턴스에서 실행 중일 수 있다.
- 워머는 사용자 트래픽과 동일한 프로세스에서 실행되므로 라이브 요청에 할당된 `batchQuery()` 슬롯을 빼앗으면 안 된다.

## Decision / 결정

Run a background cache prewarmer (`src/lib/cache-warmer.ts`) that periodically executes the same queries the dashboard pages would run, storing the results in the shared `node-cache` so user requests find a warm hit on first render.

대시보드 페이지가 호출하는 쿼리와 동일한 쿼리를 주기적으로 실행하여 공용 `node-cache`에 결과를 채워 두는 백그라운드 프리워머(`src/lib/cache-warmer.ts`)를 운영한다. 사용자 요청은 첫 렌더링 시점에 이미 워밍된 캐시를 만나게 된다.

Concrete parameters, confirmed from the source:

```text
WARM_INTERVAL_MS        = 4 * 60 * 1000   (240,000 ms, 4 minutes)
Initial warm delay      = 5,000 ms        (after startCacheWarmer())
node-cache stdTTL       = 300 s           (5 minutes, src/lib/steampipe.ts)
batchQuery BATCH_SIZE   = 8               (out of pg Pool max=10; 2 slots reserved)
Multi-account cap       = 3 accounts      (MAX_WARM_ACCOUNTS)
Zombie cleanup age      = 5 minutes       (ZOMBIE_MAX_MINUTES, every 2 min)
Monitoring queries      = 0               (DISABLED; previously 10)
Re-entry guard          = isWarming flag  (skip if previous cycle still running)
```

확인된 파라미터는 위 코드 블록과 동일하다.

Design rules:

1. **Lazy init.** `ensureCacheWarmerStarted()` is called from the first `/api/steampipe` request (not from `instrumentation.ts` or boot). Next.js boot never depends on Steampipe availability.
2. **Sequential batches of 8.** `batchQuery()` executes queries in groups of 8, leaving 2 pg Pool slots for user traffic.
3. **Monitoring queries excluded.** CloudWatch FDW calls are slow and produce zombie connections, so they are not warmed; the monitoring page fetches on demand.
4. **Multi-account warming capped at 3.** The warmer iterates accounts serially with per-account `accountId` cache keys (same isolation rule as ADR-008).
5. **Fail-soft.** If a cycle throws (for example Steampipe restarting), the exception is logged to `status.lastError`, `isWarming` is released in `finally`, and the next interval retries cleanly.

설계 규칙:

1. **지연 초기화.** 첫 `/api/steampipe` 요청 시 `ensureCacheWarmerStarted()`가 호출된다. Next.js 부팅은 Steampipe 가용성에 의존하지 않는다.
2. **8개씩 순차 배치.** `batchQuery()`는 8개씩 실행하여 pg 풀 슬롯 2개를 사용자 요청용으로 남긴다.
3. **모니터링 쿼리 제외.** CloudWatch FDW 호출은 느리고 좀비 커넥션을 만들기 때문에 워밍 대상에서 제외되며, 모니터링 페이지는 필요 시 직접 조회한다.
4. **멀티 어카운트 워밍은 최대 3계정.** 계정별 `accountId` 캐시 키로 순차 실행한다(ADR-008과 동일한 격리 규칙).
5. **Fail-soft.** 한 사이클이 실패하면 `status.lastError`에 기록하고 `finally`에서 `isWarming`을 해제한 뒤, 다음 주기에 재시도한다.

## Rationale / 근거

- **4-minute interval vs 5-minute TTL.** Refreshing 60 seconds before expiry means a user request almost never finds a stale entry.
- **Lazy init over `instrumentation.ts`.** Next.js `instrumentation.ts` runs during build and standalone mode in ways that caused spurious warms during non-production workflows. Triggering on the first API call is deterministic and production-scoped.
- **Sequential batches of 8.** With pg Pool max=10, reserving 2 slots keeps interactive requests responsive even mid-cycle.
- **Monitoring exclusion.** The tradeoff is explicit: slightly slower first monitoring-page load vs an otherwise permanently-sick pg Pool. Zombie cleanup (`startZombieCleanup()`, 5-minute threshold) complements the exclusion.
- **Per-account cache keys.** Same rationale as ADR-008: aggregator mode and per-account mode must not bleed into each other within the 5-minute window.
- **Stale-cycle protection.** The `isWarming` flag prevents overlapping cycles; long-running cycles (the `/api/report` route separately tolerates up to 30 minutes for 15-section Bedrock Opus analysis per commit `692813e`) are kept out of the warmer path.

근거 요약:

- **4분 주기 vs 5분 TTL** — 만료 60초 전 갱신이므로 사용자 요청은 거의 항상 워밍된 캐시를 만난다.
- **`instrumentation.ts` 대신 lazy-init** — 빌드 중 또는 standalone 모드에서 부작용이 있어 첫 API 호출 기반으로 변경했다.
- **8개씩 순차 배치** — pg 풀 max=10에서 2슬롯을 예약해 인터랙티브 요청 응답성을 유지한다.
- **모니터링 제외** — 첫 모니터링 페이지 로드가 살짝 느려지는 비용과 pg 풀 고갈 방지의 이득을 교환한다. 좀비 정리(`startZombieCleanup()`, 5분 기준)가 함께 동작한다.
- **계정별 캐시 키** — ADR-008과 동일한 이유로 aggregator와 계정별 뷰가 5분 TTL 내에서 섞이지 않도록 한다.
- **Stale-cycle 보호** — `isWarming` 플래그로 중첩 실행을 막는다. 장시간 분석(예: `/api/report`의 15섹션 Opus 분석, 커밋 `692813e`에서 30분 허용)은 워머 경로에서 분리한다.

## Consequences / 결과

### Positive / 긍정적

- Dashboard pages render from cache on virtually every request; perceived load time drops from seconds to sub-100 ms.
- CloudWatch FDW slowness is isolated to the monitoring page only, and zombie connections are bounded by periodic cleanup.
- pg Pool is protected from starvation by the 8-of-10 batch cap.
- Multi-account stays consistent with ADR-008 (account-scoped cache keys).
- No boot-time dependency on Steampipe: the server starts even when the DB is restarting.

대시보드는 사실상 모든 요청에서 캐시에서 렌더링되어 체감 로딩 시간이 수 초에서 100 ms 이하로 줄어든다. CloudWatch FDW의 지연은 모니터링 페이지로 격리되고, 좀비 커넥션은 주기적 정리로 경계가 잡힌다. pg 풀은 8/10 배치 제한으로 고갈을 피하고, 멀티 어카운트는 ADR-008과 동일한 계정별 키 규칙을 유지하며, Steampipe 재시작 중에도 Next.js 서버는 정상 부팅한다.

### Negative / 부정적

- The warmer continues running during idle periods, incurring a small continuous CPU/network cost.
- Memory footprint scales with account count (mitigated by the 3-account cap and 5-minute TTL).
- The warmed query list is declared in `cache-warmer.ts` code, not config, so tuning requires a code change and redeploy.
- Stale data window is up to 5 minutes. This is acceptable for AWS inventory but not for per-request metrics (hence the monitoring exclusion).
- CloudWatch-backed pages (monitoring, per-service metric drilldowns) still pay first-load latency.

워머는 유휴 시간에도 계속 실행되어 소량의 CPU/네트워크 비용이 발생한다. 메모리 사용량은 계정 수에 비례하지만 3계정 상한과 5분 TTL로 완화된다. 워밍 쿼리 목록이 코드에 선언되어 있어 튜닝 시 코드 변경과 재배포가 필요하다. 최대 5분의 stale 윈도우가 존재하며 AWS 인벤토리에는 허용되지만 요청별 메트릭에는 부적합하다(이에 따라 모니터링은 제외). CloudWatch 기반 페이지는 첫 로드 지연을 그대로 감수한다.

## References / 참조

- `src/lib/cache-warmer.ts` — Warmer implementation, status tracking, lazy-init entry point.
- `src/lib/steampipe.ts` — `batchQuery`, node-cache (300 s TTL), `startZombieCleanup`, account-scoped search_path.
- `src/app/api/steampipe/route.ts` — Calls `ensureCacheWarmerStarted()` on first request.
- Commit `692813e` — fix: restore dynamic reportBucket config and 30min stale timeout (related pg Pool / long-running analysis envelope).
- Commit `81bd23d` — fix: remove monitoring queries from cache warmer to prevent pg pool exhaustion.
- Commit `38ed114` — fix: harden pg pool and add automatic zombie connection cleanup.
- ADR-001 (`001-steampipe-pg-pool.md`) — pg Pool configuration and batch query strategy.
- ADR-008 (`008-multi-account-support.md`) — Account-scoped cache keys and aggregator pattern.
