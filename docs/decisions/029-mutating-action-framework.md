# ADR-029: Mutating Action Framework (Phase 3 of Event-Driven Pre-Scaling) / 변경 작업 프레임워크 (이벤트 기반 사전 스케일링 Phase 3)

## Status / 상태

Proposed (2026-04-26) / 제안 (2026-04-26)

This ADR specifies the framework AWSops will adopt **before any write/mutate API is enabled in production**. Implementation is gated on this ADR being Accepted; ADR-010 Phase 3 cannot start until the controls below are in place.

이 ADR은 **AWSops가 실제 운영에서 write/mutate API를 활성화하기 전**에 채택해야 하는 프레임워크를 정의한다. ADR-010 Phase 3 구현은 이 ADR이 Accepted 되고 아래 통제가 마련된 이후에만 시작할 수 있다.

## Context / 컨텍스트

ADR-010 (Event-Driven Pre-Scaling) was accepted for Phase 1+2 only — read, analyze, and generate review-ready scripts. Phase 3 (in-dashboard execution + rollback + KEDA installation + IAM expansion) was deferred because it would be the **first time AWSops mutates customer infrastructure**. The blast radius and reversibility of those actions are categorically different from anything the dashboard does today, so we want a single framework that governs **all future mutating capabilities** — not just event scaling. Future mutating features (e.g., one-click remediation from the alert pipeline, auto-rightsizing) must reuse this framework rather than re-litigate IAM/approval design.

ADR-010(이벤트 기반 사전 스케일링)은 Phase 1+2(읽기, 분석, 검토용 스크립트 생성)만 승인되었다. Phase 3(대시보드 내 실행 + 롤백 + KEDA 설치 + IAM 확장)은 **AWSops가 처음으로 고객 인프라를 변경하는 기능**이라는 점에서 보류되었다. 이 작업의 영향 범위와 가역성은 현재 대시보드의 어떤 동작과도 본질적으로 다르므로, 이벤트 스케일링뿐 아니라 **앞으로 추가될 모든 변경 작업**을 통제할 수 있는 단일 프레임워크가 필요하다. 향후 변경 기능(예: 알림 파이프라인의 원클릭 자동 조치, 자동 라이트사이징)은 IAM/승인 설계를 재논의하지 말고 이 프레임워크를 재사용해야 한다.

Concrete risks driving this ADR / 이 ADR이 다루는 구체적 리스크:

- **IAM scope creep / IAM 권한 확대**: ADR-010 §7 lists `autoscaling:*`, `rds:CreateDBInstanceReadReplica`, `rds:DeleteDBInstance`, `rds:ModifyDBCluster`, `kafka:UpdateBroker*`, `ec2:ModifyVolume`, `elasticloadbalancing:Modify*`. With `Resource: "*"`, the EC2 role can mutate **any** ASG, RDS, MSK, EBS, and ALB in the account. There is no compensating control today.
- **No idempotency or replay protection / 멱등성·재실행 보호 없음**: a stuck "Phase 2 executing" entry could be re-clicked and double-scale a cluster. There is no per-action token.
- **KEDA blast radius / KEDA 영향 범위**: installing KEDA changes how *every* EKS workload using HPA-via-KEDA scales. A misconfigured `ScaledObject` patch can put production replicas to zero.
- **Rollback partial failure / 롤백 부분 실패**: deleting an Aurora replica created during warm-up can hang for 20+ minutes, leaving the system in an undefined state with no operator-visible queue.
- **Cross-account ambiguity / 크로스 어카운트 모호성**: ADR-008 lets the dashboard *read* multiple accounts via assume-role. Phase 3 does not specify whether mutations follow the same path or are restricted to the host account.
- **Audit gap / 감사 공백**: ADR-010 §7 says actions are "logged to `data/event-scaling/`" — that is a JSON file on a single EC2 instance, not durable forensic evidence.

## Options Considered / 검토한 옵션

### Option 1: Inline execution from EC2 with elevated IAM (the ADR-010 §7 sketch as-is) / EC2에서 직접 실행 + IAM 확장

The Next.js process on EC2 calls `aws` CLI / `kubectl` directly, using the role attached to the instance.

Next.js 프로세스가 EC2에 부착된 역할로 `aws` CLI / `kubectl`을 직접 호출한다.

- **Pros / 장점**: simplest; no new infrastructure; consistent with how AWSops already runs read commands.
- **Cons / 단점**: any RCE on the dashboard becomes infrastructure compromise; one IAM role accumulates write permissions for every future mutating feature; rollback is in-process, so a Next.js restart loses state; CloudTrail attribution is "the EC2 role," not the operator who clicked.

### Option 2: Per-action Lambda dispatcher with scoped roles + Step Functions for multi-phase orchestration / 작업별 Lambda 디스패처 + 다단계는 Step Functions

Each mutating action (e.g., `setAsgCapacity`, `scaleMsk`, `applyKedaScaledObject`) is a Lambda with a narrow IAM role. The dashboard signs and submits intent; Lambda validates, executes, and emits CloudTrail. Multi-phase plans run as Step Functions state machines so phase progress survives dashboard restarts.

각 변경 작업(`setAsgCapacity`, `scaleMsk`, `applyKedaScaledObject` 등)을 별도 Lambda + 좁은 IAM 역할로 분리한다. 대시보드는 의도를 서명·제출하고, Lambda가 검증·실행·CloudTrail 기록을 담당한다. 다단계 플랜은 Step Functions 상태 머신으로 실행하여 대시보드 재시작 후에도 진행 상태가 유지된다.

- **Pros / 장점**: least-privilege at the action level; each Lambda has 1–2 IAM actions; native retry/timeout/idempotency token support; CloudTrail records the Lambda + the operator passed in payload; Step Functions provides durable phase state; reuses existing finops MCP Lambda pattern (ADR-015).
- **Cons / 단점**: ~10 new Lambda functions, 1 Step Functions state machine, additional CDK; cold-start overhead during phase transitions; cross-account requires explicit assume-role chain in each Lambda.

### Option 3: GitOps with ArgoCD + Terraform CI for AWS resources / GitOps (ArgoCD + Terraform CI)

Dashboard generates manifests/HCL → commits to a Git repo → ArgoCD/CI applies.

대시보드가 매니페스트/HCL을 생성하여 Git에 커밋 → ArgoCD/CI가 적용한다.

- **Pros / 장점**: full Git history is the audit trail; declarative rollback via revert; matches mature SRE practice.
- **Cons / 단점**: requires bootstrapping ArgoCD + a Terraform pipeline + bot credentials per account; Git push → CI → apply latency (~5–15 min) is incompatible with T-30m warm-up windows; "approve a PR before flash sale" is operationally awkward; AWSops becomes coupled to a specific GitOps stack the customer may not own.

### Option 4: Hybrid — Step Functions for AWS resources + dashboard-side `kubectl exec` for KEDA / 하이브리드 — AWS 리소스는 Step Functions, KEDA는 대시보드 직접

AWS resource mutations go through Option 2. KEDA `ScaledObject` patches are kubectl-applied from the EC2 instance using the existing EKS access entry.

AWS 리소스 변경은 Option 2 경로를, KEDA `ScaledObject` 패치는 기존 EKS Access Entry를 사용하여 EC2에서 직접 kubectl로 적용한다.

- **Pros / 장점**: keeps Lambda count down (KEDA doesn't justify its own Lambda); Lambda still owns the dangerous IAM mutations.
- **Cons / 단점**: two execution paths to test, monitor, and document; the EC2 role still needs broad EKS RBAC for cluster-admin-equivalent KEDA patches.

## Decision / 결정

**Option 2: Per-action Lambda dispatcher + Step Functions, with the framework controls below.** This pattern is the only one that contains the IAM blast radius **per action** rather than per role, and durable Step Functions execution is the only credible answer to the "phase 2 hung at 70%" failure mode that ADR-010 §7 does not address.

**Option 2(작업별 Lambda 디스패처 + Step Functions)** + 아래 프레임워크 통제. 이 패턴만이 IAM 영향 범위를 역할 단위가 아닌 **작업 단위**로 봉쇄하며, Step Functions의 영속적 실행이 ADR-010 §7이 다루지 않은 "Phase 2가 70%에서 멈춤" 시나리오에 대한 유일한 신뢰할 수 있는 답이다.

The framework — applicable to any future mutating feature — is:

이 프레임워크는 향후 모든 변경 기능에 적용된다:

### 1. Action Catalog & IAM Decomposition / 작업 카탈로그와 IAM 분해

Every mutating capability is registered in a typed catalog (`src/lib/mutating-actions/registry.ts`). Each entry declares: action name, target resource type, required IAM actions, required input fields, dry-run output schema, and rollback action reference. The CDK stack reads the catalog and emits **one Lambda per action** with **only the IAM actions that entry declares**. Adding a new mutating capability is a code review of one catalog entry, not a hand-edit of a shared role.

모든 변경 기능은 타입이 지정된 카탈로그에 등록한다. 각 항목은 작업명, 대상 리소스 타입, 필요한 IAM 액션, 입력 필드, dry-run 출력 스키마, 롤백 작업 참조를 선언한다. CDK는 카탈로그를 읽어 **작업당 Lambda 하나 + 해당 항목이 선언한 IAM 액션만**으로 배포한다. 신규 변경 기능 추가는 공유 역할 수정이 아니라 카탈로그 한 항목의 코드 리뷰가 된다.

Hard constraints on every action role / 모든 작업 역할의 필수 제약:

- `aws:RequestedRegion` condition pinned to the configured region(s)
- `aws:ResourceTag/awsops:managed-by-event = ${eventId}` condition where the resource type supports tag-on-create (Aurora replicas, EBS modifications, ASG launch configs); for resources that don't, the action input must specify an exact resource ARN/ID and the Lambda enforces an allowlist match
- No `iam:*`, no `kms:*` (use existing KMS keys via grants, never create), no `ec2:RunInstances` (use ASG capacity changes instead), no `Delete*` for retained resources beyond the action's own cleanup scope

### 2. Two-Step Submission with Idempotency / 멱등성 토큰 기반 2단계 제출

Submission flow / 제출 흐름:

1. **Plan**: dashboard `POST /api/mutating-actions/plan` → returns `{planId, dryRun, idempotencyToken, expiresAt (5 min)}`. Dry-run shows the exact API calls, before/after values, estimated cost delta. No mutation.
2. **Approve & Execute**: dashboard `POST /api/mutating-actions/execute {planId, idempotencyToken}` → only the same `planId` + `idempotencyToken` succeeds; replay returns the prior result with HTTP 200 and `replayed: true`.

This eliminates the "double-click executes twice" failure mode and gives operators a concrete artifact (the dry-run) to attach to a change ticket.

이 흐름이 "더블클릭으로 두 번 실행" 실패 시나리오를 제거하고, 변경 티켓에 첨부할 수 있는 구체적 산출물(dry-run)을 제공한다.

### 3. Mandatory Dry-Run / 필수 dry-run

Every action must implement a dry-run that produces the same shape of output as the real run, just without the side effect. The Step Functions state machine's first state is *always* a parallel dry-run of every phase; if any dry-run fails (validation error, IAM denial, resource not found), the whole plan fails before any mutation. ADR-010 §7 listed dry-run as "optional" — this ADR makes it required.

모든 작업은 실제 실행과 동일한 형태의 출력을 생성하되 side effect만 없는 dry-run을 구현해야 한다. Step Functions 상태 머신의 첫 상태는 *항상* 모든 phase의 병렬 dry-run이며, 하나라도 실패(검증 오류, IAM 거부, 리소스 없음)하면 변경 없이 전체 플랜이 실패한다. ADR-010 §7은 dry-run을 "선택"으로 두었지만 이 ADR에서는 **필수**로 격상한다.

### 4. Approval Model / 승인 모델

- Same admin gate as ADR-023 (`adminEmails`) is required to *create* a plan.
- Execute requires either (a) a separate `approvedBy` admin email different from the creator (4-eyes), or (b) an explicit `singleOperatorApproved: true` flag with `dual-control: false` in `data/config.json`. Default is 4-eyes ON.
- The approver's email is captured in the Step Functions input and forwarded into CloudTrail's `sourceIPAddress`/`userAgent` augmentation via Lambda log lines.

- ADR-023의 admin 게이트(`adminEmails`)가 플랜 생성에 필수.
- 실행은 (a) 생성자와 다른 `approvedBy` admin 이메일(4-eyes) 또는 (b) `data/config.json`의 `dual-control: false` + `singleOperatorApproved: true` 플래그 중 하나가 필요. 기본은 4-eyes ON.
- 승인자 이메일은 Step Functions 입력에 기록되고 Lambda 로그 라인을 통해 CloudTrail의 `sourceIPAddress`/`userAgent` 보강 필드로 전달된다.

### 5. Rollback as a First-Class Plan / 롤백은 1급 플랜

Every plan generates a paired *rollback plan* at submission time, stored alongside the forward plan with the same idempotency contract. Rollback is **not** "reverse the forward plan" — it is a separately-validated, separately-dry-run artifact that captures the pre-mutation state at submission time. If the forward plan partially executes and any phase fails, the Step Functions catch handler invokes the rollback plan automatically (configurable per action: `auto`, `manual`, `never`). Rollback execution is tracked the same way as forward execution and surfaces in the same dashboard UI.

모든 플랜은 제출 시점에 *롤백 플랜*을 함께 생성하여 forward 플랜과 동일한 멱등성 계약으로 저장한다. 롤백은 "forward 플랜의 역순 실행"이 **아니라**, 제출 시점의 변경 전 상태를 포착한 별도 검증·별도 dry-run된 산출물이다. forward 실행 중 어떤 phase가 실패하면 Step Functions catch 핸들러가 롤백 플랜을 자동 실행한다(작업별 설정: `auto`, `manual`, `never`). 롤백 실행은 forward 실행과 동일한 방식으로 추적되며 같은 대시보드 UI에 노출된다.

### 6. Audit & Forensic Evidence / 감사·증거

Three independent audit sinks; failure to write to any one fails the action:

세 개의 독립 감사 싱크를 두며, 어느 하나라도 기록 실패 시 작업은 실패로 처리한다:

- **CloudTrail** (intrinsic): each Lambda's API call. Operator email is appended to the Lambda's `User-Agent` so it lands in `userAgent` and `requestParameters`.
- **S3 Object Lock bucket** (governance mode, 1-year retention): full plan + dry-run + execute result + rollback artifact, written by the executor Lambda before returning success. JSON files keyed by `planId/v{version}/`.
- **`data/event-scaling/` (and equivalent per-feature directory)** stays as a low-latency operator-readable cache, but is *not* the system of record.

The S3 bucket replaces ADR-010 §7's "logged to `data/event-scaling/`" claim, which is not a durable audit channel.

S3 버킷이 ADR-010 §7의 "data/event-scaling/에 로깅" 표현을 대체한다. 후자는 영속적 감사 채널이 아니다.

### 7. KEDA Installation Scope / KEDA 설치 범위

KEDA installation is **not** a runtime mutating action. It is a one-time setup script (`scripts/13-setup-keda.sh`) that the customer runs out-of-band, the same way they run `00-deploy-infra.sh`. The runtime path only *patches* existing `ScaledObject` resources via a `kubectl-apply-scaledobject` action that requires the `ScaledObject` to already exist — the Lambda refuses to create new `ScaledObject` resources to prevent uncontrolled introduction of autoscaling to workloads. New `ScaledObject` creation requires the operator to commit it to the customer's infrastructure repo first.

KEDA 설치는 런타임 변경 작업이 **아니다**. `scripts/13-setup-keda.sh`로 고객이 직접 실행하는 일회성 설정 스크립트(`00-deploy-infra.sh`와 동급)다. 런타임 경로는 `kubectl-apply-scaledobject` 작업으로 *기존* `ScaledObject` 리소스의 패치만 가능하며, Lambda는 새 `ScaledObject` 생성을 거부한다 — 워크로드에 통제되지 않은 오토스케일링이 도입되는 것을 막기 위함이다. 새 `ScaledObject`는 운영자가 고객 인프라 저장소에 커밋한 후에 사용해야 한다.

### 8. Cross-Account Posture / 크로스 어카운트 자세

For v1, **mutating actions are restricted to the host account only**. The dashboard reads multi-account state (ADR-008) but writes only where it lives. Lifting this restriction is a future ADR; until then, the executor Lambdas reject non-host `accountId` values at the entry validator.

v1에서는 **변경 작업을 호스트 어카운트로만 제한**한다. 대시보드는 여러 어카운트 상태를 *읽지만*(ADR-008) 쓰기는 자기가 사는 어카운트에 한정한다. 이 제약 해제는 별도 ADR; 그 전까지 executor Lambda는 진입 검증기에서 비-호스트 `accountId` 값을 거부한다.

### 9. Kill Switch / 킬 스위치

A single SSM Parameter `/awsops/mutating-actions/enabled` (default `false`) gates every executor Lambda. Setting it to `false` causes in-flight Step Functions executions to fail-fast at the next state transition and prevents new plans from executing (planning still works, so dry-run remains available). The dashboard surfaces this state and the email of whoever last toggled it.

단일 SSM Parameter `/awsops/mutating-actions/enabled` (기본값 `false`)가 모든 executor Lambda를 게이트한다. `false`로 변경하면 진행 중인 Step Functions 실행은 다음 상태 전이에서 즉시 실패하고, 새 플랜은 실행되지 않는다(플래닝은 여전히 작동하므로 dry-run은 가용). 대시보드는 이 상태와 마지막 토글한 사용자의 이메일을 노출한다.

## Implementation Plan / 구현 계획

This ADR introduces no code on its own. ADR-010 Phase 3 (and any future mutating feature) is the first consumer.

이 ADR 자체는 코드를 추가하지 않는다. ADR-010 Phase 3(및 향후 모든 변경 기능)이 첫 소비자다.

| Step | Owner | Deliverable |
|------|-------|-------------|
| 1 | Infra | New CDK stack `MutatingActionsStack` — S3 audit bucket (Object Lock), SSM kill switch, base IAM policy, CloudTrail data events to the bucket |
| 2 | Infra | Step Functions state machine template (dry-run-all → approval gate → execute-phases → rollback-on-error) |
| 3 | Lib | `src/lib/mutating-actions/registry.ts` — typed catalog, plan/execute/rollback orchestration, idempotency store |
| 4 | API | `src/app/api/mutating-actions/route.ts` — `plan`, `execute`, `status`, `cancel` endpoints; ADR-023 admin gate; 4-eyes enforcement |
| 5 | UI | Reusable `<MutatingActionDryRun />` component for any feature page (event scaling first, future remediation/rightsizing reuse) |
| 6 | Adopters | ADR-010 Phase 3 migrates each script generator from `event-scaling-scripts.ts` into a registry entry + Lambda; legacy script-download path stays as fallback |

## Consequences / 영향

### Positive / 긍정적
- IAM blast radius is bounded per-action, not per-role; future mutating features cannot piggyback on an over-broad role.
- Step Functions provides durable execution state — phases survive dashboard restarts, deployments, and EC2 replacement.
- 4-eyes default + dry-run-required + S3 Object Lock audit gives a defensible posture against accidental and (most) insider misuse.
- The rollback contract becomes uniform across features rather than each feature inventing its own.
- The kill switch gives a single, fast operator response to a misbehaving release.

### Negative / 부정적
- Significant new infrastructure: ~1 new CDK stack, 1 Step Functions state machine, N action Lambdas (where N = number of registered actions, ~10 for ADR-010 Phase 3 alone).
- Two-step plan/execute flow adds latency vs. one-click. Acceptable for warm-up windows measured in minutes; not acceptable for real-time auto-remediation (a future ADR can address that with pre-issued plan tokens).
- Cold-start during phase transitions can add 200–800 ms per phase. Mitigation: provisioned concurrency on the most-used executors only.
- 4-eyes default will be friction for solo-admin deployments. The `dual-control: false` escape hatch is supported but logged at every execution.
- KEDA `ScaledObject` creation must happen out-of-band; teams used to "configure-as-you-go" will find this slower.

### Post-acceptance deviations / 채택 후 변경 사항
- *(none yet)*

## References / 참고 자료
- [ADR-010: Event-Driven Pre-Scaling](./010-event-driven-pre-scaling.md) — Phase 1+2 producer of plans this framework executes
- [ADR-008: Multi-Account Support](./008-multi-account-support.md) — read path; this ADR explicitly does *not* extend to write
- [ADR-015: FinOps MCP Lambda](./015-finops-mcp-lambda.md) — existing per-action Lambda pattern this ADR generalizes
- [ADR-023: Admin Role Model](./023-admin-role-model-adminemails.md) — the gate this ADR builds on
- [AWS Step Functions Standard Workflows](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-standard-vs-express.html) — durable execution model
- [S3 Object Lock — Governance vs. Compliance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-overview.html) — audit retention model
- [KEDA ScaledObject](https://keda.sh/docs/concepts/scaling-deployments/) — patch-only constraint rationale
