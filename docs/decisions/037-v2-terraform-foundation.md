# ADR-037: v2 Foundation — Terraform + thin-BFF Web + Async Worker Tier (CDK retired) / v2 파운데이션 — Terraform + thin-BFF 웹 + 비동기 워커 티어 (CDK 폐기)

## Status / 상태

Accepted (2026-06-10) / 채택 (2026-06-10) — co-agent consensus ADR-consistency review (kiro·codex·gemini, Claude chair). Records the v2 deployment foundation that was implemented ahead of its decision record (the "documentation debt" the panel flagged). **Supersedes ADR-024 (CDK three-stack) in full** and **refines / partially supersedes the *mechanism* of ADR-030** (the four-container / Service-Connect-Steampipe / CDK-refactor topology), while preserving ADR-030's Aurora-for-app-state and dual-tier-ECR *intent*.

co-agent 합의 ADR 일관성 리뷰로 기록. v2 배포 파운데이션이 결정 기록보다 먼저 구현된 "문서 부채"를 정정한다. **ADR-024(CDK 3-stack)를 전면 승계**하고, **ADR-030의 *메커니즘*(4-컨테이너 / Service Connect Steampipe / CDK 리팩터 토폴로지)을 정제·부분 승계**하되 ADR-030의 Aurora 앱-상태 + 이중 ECR *의도*는 보존한다.

## Context / 컨텍스트

ADR-024 chose a **CDK three-stack split** (Awsops / Cognito / AgentCore) for v1 on a single EC2 host. ADR-030 then proposed the v2 move to ECS Fargate + Aurora, but its body described a specific topology — **four ECS services** (`awsops-web`, `awsops-steampipe`, `awsops-alert-poller`, `awsops-jobs`), **Service Connect DNS** to a long-lived Steampipe daemon (`awsops-steampipe.awsops.local:9193`), a **CDK refactor** into three stacks, and Public-ECR cosign OSS distribution — that was **never built that way**. v2 was instead implemented as:

ADR-024는 v1 단일 EC2용 **CDK 3-stack 분할**을 채택했다. 이후 ADR-030이 v2의 ECS Fargate + Aurora 이전을 제안했으나, 본문이 기술한 구체 토폴로지(**4개 ECS 서비스** `awsops-web`/`awsops-steampipe`/`awsops-alert-poller`/`awsops-jobs`, 상시 Steampipe 데몬으로의 **Service Connect DNS**, **CDK 리팩터** 3-stack, Public-ECR cosign OSS 배포)는 **그렇게 구현된 적이 없다**. v2는 다음으로 구현됐다:

- **Terraform**, not CDK. Single root `terraform/v2/foundation/` with a **partial S3 backend** (`backend.hcl`, bucket `awsops-v2-tfstate`, `use_lockfile` — no DynamoDB lock table). TF ≥ 1.15, provider `~> 6.0`.
- A **single web service** (`awsops-v2-web`, Next.js 14 standalone, arm64 Fargate, root path) acting as a **thin-BFF** — heavy/long/OOM-risk work is enqueued, not run inline.
- An **async worker tier** (`workers_enabled`-gated): `POST /api/jobs` → `worker_jobs` (Aurora) + SQS → ESM kill-switch → dispatcher Lambda → **Step Functions Standard** (`$.runtime` Choice) → Lambda (short) or `ecs:runTask.sync` Fargate (long/OOM) → reaper reconciliation. This is the single durable orchestration spine (the substrate ADR-036 reuses).
- **No live Steampipe.** Live AWS queries go through **AgentCore MCP Lambda tools** (ADR-002 routing realized as AgentCore section agents). The only Steampipe in v2 is a **flag-gated warm inventory-sync** Fargate task + sync Lambda → Aurora (`terraform/v2/foundation/steampipe.tf`, `var.steampipe_enabled`, default **off**) — a batch loader, not a Service-Connect live-query daemon. (Resolves the ADR-001/005/030 Steampipe drift.)
- **Edge**: CloudFront → **VPC Origin** `https-only:443` → **internal ALB** HTTPS:443 (regional ACM) → Fargate. No public ALB.
- New feature surface is **count/flag-gated** (`agentcore_enabled`, `workers_enabled`, `steampipe_enabled` — all default false → `plan` = No changes, $0 until toggled).

This ADR ratifies that implemented foundation as the decision of record so downstream ADRs stop referencing a CDK/EC2/Service-Connect-Steampipe substrate that no longer exists.

이 ADR은 구현된 파운데이션을 공식 결정으로 비준하여, 하위 ADR들이 더 이상 존재하지 않는 CDK/EC2/Service-Connect-Steampipe 기반을 참조하지 않게 한다.

## Decision / 결정

1. **IaC = Terraform** (partial S3 backend, single `terraform/v2/foundation/` root). CDK is retired for v2; `infra-cdk/` remains v1 history only. Shared-infra applies use a saved tfplan (`apply tfplan`) — no `-auto-approve` on shared infra. / **IaC는 Terraform**(부분 S3 backend). v2에서 CDK 폐기, `infra-cdk/`는 v1 이력 전용.
2. **Compute = ECS Fargate (arm64)**, split into a **thin-BFF web service** + a **flag-gated async worker tier** (SQS → Step Functions Standard → Lambda/Fargate). No `awsops-steampipe` / `awsops-alert-poller` / `awsops-jobs` long-lived containers; their v1 responsibilities map onto the worker tier or AgentCore. / **컴퓨트는 ECS Fargate(arm64)** — thin-BFF 웹 + flag-gated 비동기 워커 티어.
3. **App state = Aurora Serverless v2 (PG 17.9)** via node-pg (`web/lib/db.ts`), schema in `terraform/v2/foundation/data/schema.sql` + `schema_migrations`. (Grew from ADR-030's initial 7 tables to the current **baseline `data/schema.sql` (frozen at v9, 29 app tables)** + ULID migrations (`migrations/<ULID>_*.sql`, `make migrate`) — schema.sql is the source of truth for the table count. / ADR-030의 초기 7-테이블에서 출발해 현재 **베이스라인 `data/schema.sql`(v9 동결, 29 앱 테이블)** + ULID 마이그레이션으로 성장 — 테이블 수는 schema.sql이 source of truth.) `data/*.json` (the v1 pattern) is not used. / **앱 상태는 Aurora Serverless v2**.
4. **Live AWS queries = AgentCore MCP Lambda tools.** **No live Steampipe in v2.** A flag-gated warm Steampipe inventory-sync (Fargate + sync Lambda → Aurora) exists as a batch loader only, default off. / **라이브 조회는 AgentCore MCP**; 라이브 Steampipe 없음, 인벤토리 sync는 flag-gated 배치.
5. **Config source-of-truth = SSM** for AgentCore (`/ops/awsops-v2/agentcore/*`) and the admin allowlist (read by `web/lib/admin.ts` — Cognito group OR SSM email list; see the ADR-023 v2 note). Bootstrap/runtime config is SSM/env, not a mounted `data/config.json`. / **설정 출처는 SSM**(AgentCore·admin allowlist), `data/config.json` 미사용.
6. **Relationships** / 관계:

| Relationship | ADR | Meaning |
|---|---|---|
| **supersedes (full)** | ADR-024 | The CDK three-stack split is replaced by the Terraform single-root foundation. ADR-024 stays Accepted as **v1 history**; its topology does not apply to v2. |
| **refines / partially supersedes** | ADR-030 | Replaces ADR-030's *mechanism* (4 containers, Service-Connect Steampipe daemon, CDK refactor, the `data/config.json` file-mount, the cache-warmer-in-`awsops-jobs` open follow-up). **Retains** ADR-030's *intent*: Aurora replaces the v1 JSON state layer; dual-tier ECR (dev-private / prod-public) for OSS distribution. |
| **supersedes the v2 mechanism of** | ADR-001 / ADR-005 | Steampipe pg-Pool/VPC-Lambda host-location assumptions: v2 has no live Steampipe (AgentCore MCP replaces it); only a flag-gated inventory-sync remains. The pg-Pool-over-CLI principle (ADR-001) is moot in v2. |
| **provides foundation for** | ADR-029 / ADR-036 | The mutating-action controls (029) and the hybrid execution substrate (036) were built on this Terraform/Fargate/Aurora foundation + P2 worker backbone. **⛔ Both were REVERSED on 2026-06-11** (do-not-enable, flag-OFF frozen — see `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`); the foundation itself is unaffected and the dark substrate code remains harmless. AWSops stays read-only; this foundation now serves async jobs + read-only AI, not mutation. |
| **relates** | ADR-023 | Admin authority in v2 is Cognito group + SSM allowlist (`web/lib/admin.ts`), not `data/config.json` `adminEmails`. |

## Consequences / 영향

### Positive / 긍정적
- One authoritative record of the v2 foundation; downstream ADRs (029/030/031/032/034/036) can reference it instead of repeating or contradicting stale CDK/EC2/Steampipe assumptions. / v2 파운데이션 단일 권위 기록.
- The thin-BFF + worker-tier split keeps the request path fast and OOM-safe; one durable spine (P2) serves async jobs (and *had* served the now-reversed ADR-036 mutation path — frozen flag-OFF since 2026-06-11). / thin-BFF + 워커 분리로 요청 경로 경량·OOM 안전, 단일 spine (036 mutation 경로는 2026-06-11 번복·동결).
- Flag-gating (`agentcore_enabled`/`workers_enabled`/`steampipe_enabled`) keeps idle cost at $0 and makes feature rollout reversible. / flag 게이트로 유휴 비용 0·롤백 가능.

### Negative / 부정적
- Terraform partial S3 backend without a DynamoDB lock relies on `use_lockfile` (S3 conditional writes); concurrent applies must still be serialized operationally. / DynamoDB 잠금 부재 → `use_lockfile` 의존, 동시 apply는 운영적으로 직렬화 필요.
- ADR-030's body remains as historical narrative; readers must treat this ADR (037) as the authoritative v2 topology and 030 as Aurora/ECR-intent-only. / 030 본문은 이력으로 남음 — v2 토폴로지 권위는 037.
- Steampipe being default-off means inventory pages depend on an explicit opt-in (`steampipe_enabled=true` + sync run); the dependency must be documented per page. / Steampipe default-off → 인벤토리 페이지는 opt-in 의존.

### Post-acceptance deviations / 채택 후 편차
- (none yet) / (아직 없음)

## References / 참고 자료
- ADR-024 (CDK three-stack — superseded here), ADR-030 (ECS Fargate + Aurora — mechanism refined here, intent retained), ADR-001/005 (Steampipe pg Pool / VPC Lambda — v2 host assumptions superseded), ADR-029/036 (mutating controls + execution substrate built on this foundation), ADR-023 (admin model — v2 uses SSM + Cognito group)
- `terraform/v2/foundation/` (single root, partial S3 backend), `terraform/v2/foundation/steampipe.tf` (`var.steampipe_enabled`), `web/lib/db.ts` (Aurora node-pg), `web/lib/admin.ts` (Cognito group + SSM allowlist)
- Component reference (current source of truth): `docs/superpowers/reference/01-edge-network.md`, `03-data-aurora.md`, `04-web-bff.md`, `06-workers.md`
- Co-authored via `/co-agent` review mode; ADR-consistency cross-review by kiro / codex / gemini, Claude as chair (2026-06-10).
