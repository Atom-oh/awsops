# 06. Async Worker Backbone — v2 Reference

## Purpose / 목적

**EN** — A managed async backbone that lifts heavy, long-running, or OOM-prone work off the
web request path. The web tier stays a thin BFF; a worker can OOM, hang, or crash without
affecting web availability. P2 shipped the backbone + a synthetic proof workload
(`noop`/`noop-heavy`) — **real read-only heavy ops have since landed on top of it**: `report`
(full AI diagnosis report generation), `compliance` (CIS benchmark via Powerpipe),
`datasource_index`, and `insight` are all live registered handlers today, each with its own
EventBridge-scheduled dispatcher Lambda (see Key files). Mutating actions remain deferred
(ADR-005 FROZEN) — the "real ops land in P3+" framing applies to *mutation*, not to heavy
read-only work, which is already here.

**KO** — 무겁거나 오래 걸리거나 OOM 위험이 있는 작업을 web 요청 경로에서 떼어내는 관리형 비동기
백본. web은 thin BFF로 유지되고, 워커가 OOM·행·크래시로 죽어도 web 가용성은 무영향. P2는 백본 +
합성 증명 워크로드(`noop`/`noop-heavy`)를 제공했고, **그 위에 실제 read-only heavy op이 이미
올라와 있다**: `report`(AI 진단 리포트 전체 생성), `compliance`(Powerpipe CIS 벤치마크),
`datasource_index`, `insight`가 전부 현재 등록된 실제 핸들러이며, 각각 EventBridge 스케줄 디스패처
Lambda를 갖는다(Key files 참조). mutate 작업만 계속 연기된 상태(ADR-005 FROZEN) — "실제 ops는
P3+에서"라는 서술은 *mutation*에만 해당하고, 무거운 read-only 작업은 이미 여기 있다.

## Current design / 현행 설계

**Flow / 흐름**

```
web POST /api/jobs
  → INSERT worker_jobs (status=queued) + SQS SendMessage {job_id, type, payload, dry_run}
  → SQS Event Source Mapping  ← THE KILL-SWITCH (enable/disable this ESM to pause/resume all dispatch)
  → dispatcher Lambda (no VPC; idempotent on job_id; type-guard: registry-only, mutate/unknown rejected)
  → Step Functions (STANDARD)
       Choice on $.runtime:
         ├─ RunLambda  → worker Lambda           (short jobs, <15min)
         └─ RunFargate → ecs:runTask.sync         (long / OOM-risk jobs, arm64)
       the worker itself: claims running → writes succeeded
       on any Catch → status_updater Lambda sets failed   ← SFN cannot write VPC-only Aurora
       → JobFailed
  reaper Lambda (EventBridge rate(5 min)) reconciles stale rows (running→failed; queued→failed when ESM enabled)
```

**EN** — `POST /api/jobs` writes the durable ledger row first (source of truth), then best-effort
SQS send. The dispatcher Lambda runs outside the VPC (reaches SQS/SFN APIs directly), validates
the job type against the `handlers.py` registry (read/compute only — mutate/unknown rejected per
ADR-005), and calls `StartExecution(name=job_id)` — the execution name gives transport-level
idempotency (`ExecutionAlreadyExists` is treated as success). Step Functions Standard routes on
`$.runtime`: a `RunLambda` state for short jobs, or `ecs:runTask.sync` Fargate for long/OOM-risk
jobs. The worker claims `running` and writes `succeeded` itself. Because SFN cannot issue SQL to
VPC-only Aurora (RDS Data API not adopted), the `Catch` path invokes a VPC-attached
`status_updater` Lambda to set `failed`. A reaper (EventBridge, every 5 min) reconciles orphaned
rows. **Everything is gated by `workers_enabled` (default false → `terraform plan` = No changes,
$0 idle).**

**KO** — `POST /api/jobs`는 내구성 있는 ledger 행을 먼저 쓰고(권위), 그 다음 best-effort SQS send.
디스패처 Lambda는 VPC 밖에서 동작(SQS/SFN API 직접 접근)하고 `handlers.py` 레지스트리로 타입을
검증(read/compute만 — mutate/unknown 거부, ADR-005)한 뒤 `StartExecution(name=job_id)` 호출 —
실행명이 transport 멱등을 제공(`ExecutionAlreadyExists`는 성공 처리). Step Functions Standard가
`$.runtime`으로 라우팅: 짧은 잡은 `RunLambda`, 길거나 OOM 위험인 잡은 `ecs:runTask.sync` Fargate.
워커가 직접 `running`을 claim하고 `succeeded`를 쓴다. SFN은 VPC-only Aurora에 직접 SQL을 못 쓰므로
(RDS Data API 미채택), `Catch` 경로가 VPC-attached `status_updater` Lambda를 호출해 `failed`로
전이한다. reaper(EventBridge, 5분마다)가 고아 행을 보정. **모든 것이 `workers_enabled`로 게이트됨
(기본 false → `terraform plan` = No changes, 유휴 $0).**

## Decisions (ADRs) / 결정

- **[ADR-005 — AWS mutation & autonomy (FROZEN)](../../decisions/005-aws-mutation-autonomy-frozen.md)** — workers
  are the execution surface for the gated mutating operations. P2 implements the *safety hooks* only
  (idempotency token, kill-switch, mutate/unknown-type guard, dry-run pass-through); approval workflow,
  first-class rollback, and the mutate-action registry are deferred to P3+ (no mutate ops exist yet).
  / 워커는 게이트된 mutate 작업의 실행 표면. P2는 안전 훅(멱등 토큰·킬스위치·mutate/unknown 타입
  가드·dry-run 통과)만 구현; 승인 워크플로·1급 롤백·mutate-action 레지스트리는 P3+로 연기.
- **[ADR-001 — v2 foundation (ECS/Fargate + Aurora split)](../../decisions/001-v2-foundation.md)** — the job
  ledger is the Aurora `worker_jobs` table (an infra table orthogonal to the 7 app-state tables); the
  worker_jobs row, not the SFN execution status, is the source of truth.
  / 잡 ledger는 Aurora `worker_jobs` 테이블(7개 app-state 테이블과 직교하는 인프라 테이블); 권위는
  SFN 실행 상태가 아니라 worker_jobs 행.

## Key files / 핵심 파일

| File / 파일 | Role / 역할 |
|---|---|
| `terraform/v2/foundation/workers.tf` | All P2+ infra, gated on `var.workers_enabled` (SQS+DLQ, S3 results, SFN Standard, **8 Lambdas** — the 4 core ones below plus 4 scheduled dispatchers, Fargate task def, ECR, IAM, reaper schedule, kill-switch ESM, web SQS grant) |
| `scripts/v2/workers/db.py` | Shared Aurora access (pg8000) + `worker_jobs` CRUD with conditional, terminal-immutable transitions |
| `scripts/v2/workers/dispatcher.py` | SQS-triggered: type guard + `StartExecution` (`ExecutionAlreadyExists`=ok) + `ReportBatchItemFailures`. Also branches `incident_stage` jobs to the sibling incident state machine (dropped when `incident_lifecycle_enabled` is off, the default) |
| `scripts/v2/workers/handlers.py` | Job-type registry — **6 entries, not 2**: `noop`→lambda, `noop-heavy`→fargate (the original proof workload), plus the now-live `report`→fargate (AI diagnosis report), `compliance`→fargate (CIS/Powerpipe), `datasource_index`→lambda, `insight`→lambda |
| `scripts/v2/workers/worker_lambda.py` | SFN-invoked short worker: claim running → run handler → succeeded/failed |
| `scripts/v2/workers/status_updater.py` | SFN Catch-invoked: set `failed`+error conditionally (the SFN→VPC-Aurora bridge) |
| `scripts/v2/workers/reaper.py` | EventBridge-scheduled stale-job reconciliation (running→failed; queued→failed when ESM enabled) |
| `scripts/v2/workers/fargate_worker.py` | Fargate entrypoint `--job-id [--oom]`; long task / OOM demo |
| `scripts/v2/workers/sfn.asl.json` | Step Functions ASL (Choice lambda/fargate, Retry, Catch→status_updater); Terraform `templatefile` vars |
| `scripts/v2/workers/schedule_dispatcher.py` | EventBridge-scheduled (hourly) — scans `report_schedules`, enqueues `report` jobs. Gated `diagnosis_schedule_enabled` |
| `scripts/v2/workers/ai_cost_aggregator.py` | EventBridge-scheduled (6h) — Bedrock token usage → `ai_usage_daily`. Gated `ai_cost_tracking_enabled` |
| `scripts/v2/workers/datasource_index_dispatcher.py` | EventBridge-scheduled (24h) — enqueues `datasource_index` jobs |
| `scripts/v2/workers/insight_dispatcher.py` | EventBridge-scheduled (6h) — enqueues `insight` jobs. Gated `ai_insights_enabled` |
| `web/app/api/jobs/route.ts` | `POST` enqueue (ledger insert + SQS send; `ON CONFLICT` idempotency dedup) |
| `web/app/api/jobs/[id]/route.ts` | `GET` job status/result by id |
| `web/lib/db.ts` | Shared `getPool()` (node-postgres) used by jobs routes |
| `scripts/v2/workers.mjs` | `make workers`: build+push the arm64 Fargate worker image |

## Status / 상태

**P2 ✅ — W9 GREEN, 5/5 verified.**

1. Lambda path: `noop` job → executed off the web path → `succeeded`.
2. Fargate path: `noop-heavy` job → `succeeded`.
3. OOM isolation (core criterion): Fargate `--oom` via SFN → exit 137 → `Catch` → status_updater
   sets `failed`, **web (ECS awsops-v2-web) stays healthy/serving — unaffected.**
4. Kill-switch: disable the SQS→dispatcher ESM → jobs stay `queued` (no dispatch); re-enable → resume.
5. Idempotency: duplicate `job_id` / `idempotency_key` → single job.

**Outputs:** `jobs_queue_url`, `workers_state_machine_arn`, `dispatcher_esm_uuid`, `worker_ecr_uri`.

**Since W9:** the registry grew from the 2 synthetic types verified above to 6 — `report`,
`compliance`, `datasource_index`, and `insight` are live production job types with their own
scheduled dispatcher Lambdas (see Key files). These reuse the same verified backbone (kill-switch,
idempotency, OOM isolation) rather than introducing a new path.

## Learnings & gotchas / 학습·함정

These are reuse-critical — re-read before extending the backbone.

- **Fargate Dockerfile must use `CMD`, not exec-form `ENTRYPOINT`.** SFN
  `containerOverrides.command` **REPLACES** a `CMD` but is **APPENDED** to an `ENTRYPOINT` →
  argv doubles → argparse dies → every Fargate job fails. / SFN의 command override는 CMD를
  치환하지만 ENTRYPOINT엔 덧붙음 → argv 중복 → argparse 실패.
- **SQS ESM disable has ~1–2 min poller-drain latency.** A kill-switch test must wait ~120 s after
  `State=Disabled` before asserting "stays queued." / ESM disable는 폴러 드레인에 ~1–2분 → 킬스위치
  테스트는 Disabled 후 ~120초 대기 후 assert.
- **`pg8000` is vendored as a Lambda layer** (pure-python, arch-agnostic) — attached to
  worker/status/reaper only; dispatcher needs no DB. / `pg8000`은 Lambda 레이어로 벤더링(순수 파이썬,
  아키텍처 무관); 디스패처는 DB 불요.
- **Reuse the existing `aws_security_group.service`** for the worker Lambdas + Fargate. The P1c
  Aurora SG uses inline ingress that already allows `service`; adding a standalone SG/ingress rule
  causes a perpetual diff. / 기존 `aws_security_group.service` 재사용 — Aurora SG 인라인 ingress가
  이미 허용; 별도 SG/규칙 추가 시 영구 drift.
- **Put `lifecycle { ignore_changes = [enabled] }` on the dispatcher ESM** so an out-of-band
  kill-switch pause survives later `terraform apply`. / ESM에 `ignore_changes=[enabled]` — 수동
  킬스위치 정지가 이후 apply에도 유지되도록.
- **The reaper `RUNNING_STALE_MIN` (75) must EXCEED the Fargate SFN `TimeoutSeconds` (3600 s =
  60 min)** or a ~60-min job races reap-vs-finish (reaper marks `failed`, the later `succeeded` is
  silently dropped by terminal-immutability). / reaper `RUNNING_STALE_MIN`(75)은 Fargate SFN
  `TimeoutSeconds`(3600s=60분)를 초과해야 함 — 아니면 ~60분 잡이 reap-vs-finish 경합.
- **SFN `.sync` briefly shows RUNNING after the worker already wrote `succeeded`** (task-stop
  polling lag). The `worker_jobs` ledger is the source of truth, not the SFN status. / SFN `.sync`는
  워커가 succeeded를 쓴 뒤에도 잠시 RUNNING 표시(task-stop 폴링 지연); 권위는 worker_jobs ledger.

## Source / 출처

Consolidated from the archived P2 design + plan (cite the future `archive/` paths):

- `docs/superpowers/archive/2026-06-02-awsops-v2-p2-async-worker-backbone-design.md`
- `docs/superpowers/archive/2026-06-02-awsops-v2-p2-async-worker-backbone.md`
