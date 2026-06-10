# ADR-036: Remediation / Mutation Execution Substrate (SSM Automation + Change Manager × P2 Worker Backbone) / 변경·조치 실행 substrate (SSM Automation + Change Manager × P2 워커 백본)

## Status / 상태

Accepted (2026-06-09) / 채택 (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES, codex/gemini/kiro). `.sync` 사실오류 정정 + 완료추적·승인주체·per-action IAM·통제 매핑 보완 (§Consensus Review Addenda 참조).

This ADR records *how* AWSops actually executes a mutating action. It **refines and partially supersedes the mechanism of ADR-029** (which chose a bespoke per-action Lambda + dedicated Step Functions stack) while **preserving ADR-029's six controls as a substrate-agnostic controls spec**. ADR-029 becomes a *controls* spec, not an *implementation* spec.

본 ADR은 AWSops가 변경 작업을 *어떻게* 실제로 실행하는지를 기록한다. **ADR-029의 메커니즘**(작업별 Lambda + 전용 Step Functions 스택 채택)을 **정제·부분 승계**하되, **ADR-029의 6대 통제는 substrate 무관 통제 사양으로 보존**한다. ADR-029는 *구현* 사양이 아니라 *통제* 사양이 된다.

## Context / 컨텍스트

ADR-029 decided that all future mutations run as "Option 2 — per-action Lambda dispatcher + a dedicated Step Functions framework," with six controls (typed Action Catalog + per-action IAM, two-step plan→execute with idempotency token, mandatory dry-run, 4-eyes approval, first-class paired rollback, three audit sinks). It was decided when AWSops was a single-EC2 v1 with **no durable orchestration of its own**. That premise no longer holds.

ADR-029는 향후 모든 변경을 "Option 2 — 작업별 Lambda 디스패처 + 전용 Step Functions 프레임워크"로 실행하기로, 6대 통제(타입 Action Catalog + 작업별 IAM, 멱등 토큰 2단계 plan→execute, 필수 dry-run, 4-eyes 승인, 1급 페어 롤백, 3중 감사 싱크)와 함께 결정했다. 이는 AWSops가 **자체 영속 오케스트레이션이 없는** 단일 EC2 v1이던 시점의 결정이다. 그 전제는 더 이상 성립하지 않는다.

Two facts changed it: (1) v2 already ships a **generic, durable async worker backbone** (P2, GREEN): `POST /api/jobs` → `worker_jobs` (Aurora) + SQS → kill-switch ESM → idempotent dispatcher Lambda (execution-name == `job_id`) → **Step Functions Standard** with a `$.runtime` Choice → `lambda:invoke` (short) or `ecs:runTask.sync` Fargate (long/OOM) → status to Aurora → `Catch → status_updater` → 5-min reaper reconciles. Building ADR-029's *separate* per-action SFN stack would **duplicate** this spine — two orchestration engines, two monitoring surfaces, two failure playbooks. (2) AWS-managed **SSM Automation + Change Manager** natively provide most of ADR-029's hand-rolled controls — versioned runbooks, approval templates + change calendars, CloudTrail + execution-history audit, `AutomationAssumeRole` + `TargetLocations` cross-account (clean fit with ADR-008) — and `aws:executeScript`/native `--dry-run` for many APIs.

이를 바꾼 두 사실: (1) v2는 이미 **범용·영속 비동기 워커 백본**(P2, GREEN)을 배포했다: `POST /api/jobs` → `worker_jobs`(Aurora) + SQS → 킬스위치 ESM → 멱등 디스패처 Lambda(실행명 == `job_id`) → **Step Functions Standard** `$.runtime` Choice → `lambda:invoke`(짧음) 또는 `ecs:runTask.sync` Fargate(긺/OOM) → Aurora 상태 → `Catch → status_updater` → 5분 reaper 정합화. ADR-029의 *별도* 작업별 SFN 스택을 구축하면 이 spine을 **중복**한다 — 오케스트레이션 엔진 2개, 모니터링 2면, 실패 플레이북 2개. (2) AWS 관리형 **SSM Automation + Change Manager**가 ADR-029 수제 통제의 대부분을 네이티브 제공한다 — 버전드 런북, 승인 템플릿 + 체인지 캘린더, CloudTrail + 실행 이력 감사, `AutomationAssumeRole` + `TargetLocations` 교차 계정(ADR-008과 정합) — 및 다수 API의 `aws:executeScript`/네이티브 `--dry-run`.

This decision was co-authored with three independent assistants (codex, gemini, kiro-cli). Codex and kiro-cli recommended the **Hybrid** substrate; gemini dissented toward a pure-code "augment P2" path (Option C), citing SSM YAML developer experience, non-Git-native runbook versioning, and AWS lock-in. All three **agreed** on the meta-decision: reject ADR-029's *dedicated* SFN stack (it duplicates P2), reuse P2 as the single control-plane/ledger, and reframe ADR-029 as a controls spec. All three independently assessed that adopting SSM/Change Manager deletes **~60–70%** (not 100%) of ADR-029's hand-rolled machinery.

본 결정은 세 독립 어시스턴트(codex, gemini, kiro-cli)와 공동 작성했다. codex·kiro-cli는 **Hybrid** substrate를 권고했고, gemini는 순수 코드 "P2 증강"(Option C)으로 이견을 냈다(SSM YAML 개발 경험, 비-Git-native 런북 버저닝, AWS 락인 근거). 셋 모두 메타 결정에 **합의**했다: ADR-029의 *전용* SFN 스택은 P2를 중복하므로 기각, P2를 단일 컨트롤 플레인/원장으로 재사용, ADR-029를 통제 사양으로 재구성. 셋 모두 SSM/Change Manager 채택이 ADR-029 수제 기계의 **~60–70%**(100% 아님)를 삭제한다고 독립 평가했다.

## Options Considered / 고려한 대안

### Option A: Build ADR-029's bespoke per-action Lambda + dedicated Step Functions stack as written — rejected / ADR-029 명세대로 작업별 Lambda + 전용 SFN 스택 구축 — 기각

- **Pros / 장점**: Maximum control; uniform substrate for AWS + K8s + app-state; every control exactly as designed. / 최대 통제; AWS·K8s·앱상태 단일 substrate; 모든 통제가 설계 그대로.
- **Cons / 단점**: **Fully duplicates the shipped P2 backbone** (parallel SQS/SFN/Lambda/Fargate + reaper) — two engines, two monitoring surfaces; all of approval/audit/rollback/idempotency/cross-account is permanent bespoke code; flagged as duplication by all three reviewers. / **배포된 P2 백본을 전면 중복**(병렬 SQS/SFN/Lambda/Fargate + reaper) — 엔진 2개, 모니터링 2면; 승인·감사·롤백·멱등·교차계정이 영구 수제 코드; 세 리뷰어 모두 중복으로 지적.

### Option B: SSM Automation + Change Manager as the sole substrate — rejected / SSM Automation + Change Manager 단독 substrate — 기각

- **Pros / 장점**: Managed approval/calendar/audit/rollback/cross-account; deletes most ADR-029 machinery for AWS-resource actions. / 관리형 승인·캘린더·감사·롤백·교차계정; AWS 리소스 작업의 ADR-029 기계 대부분 삭제.
- **Cons / 단점**: AWS-resource-only — cannot cleanly `kubectl`/KEDA-patch (awkward `aws:executeScript` shell-out); no generic dry-run for custom multi-phase; runbook authoring is YAML/JSON (less testable, non-Git-native versioning); splits the AWSops job ledger from mutation execution if it bypasses P2. / AWS 리소스 전용 — `kubectl`/KEDA 패치 곤란(`aws:executeScript` 쉘아웃); 커스텀 다단계의 범용 dry-run 부재; 런북 저작은 YAML/JSON(테스트성·Git 버저닝 약함); P2 우회 시 작업 원장과 실행이 분리.

### Option C: Augment the P2 worker backbone with pure-code executors only — rejected (dissent: gemini preferred this) / P2 워커 백본을 순수 코드 실행기로만 증강 — 기각 (이견: gemini 선호)

Add an approval Task-Token wait, a dry-run Choice state, and rollback Catch branches to the existing SFN; implement every action as portable Lambda/Fargate code. / 기존 SFN에 승인 Task-Token 대기, dry-run Choice, 롤백 Catch를 추가; 모든 작업을 이식 가능한 Lambda/Fargate 코드로 구현.

- **Pros / 장점**: Zero new orchestration infra; highest developer velocity (TS/Python, testable); portable (low lock-in); single observability spine; K8s/app-state trivial. / 신규 오케스트레이션 0; 개발 속도 최고(TS/Python, 테스트 용이); 이식성(락인 낮음); 단일 관측 spine; K8s·앱상태 용이.
- **Cons / 단점**: Re-implements in code what Change Manager/CloudTrail provide managed — the 4-eyes approval engine, change calendars, and audit correlation become **team-owned** and must be proven correct exactly where governance matters most; cross-account assume-role routing is hand-built (SSM does it natively); inflates the shared worker role unless IAM is rigorously decomposed. For an **AWS-only** product the portability win is largely moot. / Change Manager/CloudTrail가 관리형으로 주는 것을 코드로 재구현 — 4-eyes 승인 엔진·체인지 캘린더·감사 상관이 **팀 소유**가 되어 거버넌스가 가장 중요한 지점에서 정확성을 증명해야 함; 교차계정 assume-role 라우팅 수제(SSM은 네이티브); IAM 분해를 엄격히 안 하면 공유 워커 역할 비대. **AWS-only** 제품에서 이식성 이점은 대체로 무의미.

### Option D: Hybrid — P2 control-plane/ledger + SSM Automation/Change Manager executor for AWS-resource actions + P2 Lambda/Fargate for K8s/app-state/composite — chosen / 하이브리드 — P2 컨트롤 플레인/원장 + AWS 리소스는 SSM/Change Manager 실행기 + K8s·앱상태·복합은 P2 Lambda/Fargate — 채택

- **Pros / 장점**: P2 stays the **single front-door, idempotency ledger, status source, and UI/SSE correlation layer** — no team-owned duplication. SSM/Change Manager supplies managed approval/calendar/audit/cross-account for AWS-resource mutations (~80% of initial actions, and exactly where blast radius + audit fidelity matter most), deleting ~60–70% of ADR-029's machinery. K8s/KEDA/app-state/composite actions stay on portable P2 code, neutralizing Option B's awkward paths and Option C's governance burden. Incremental: ship SSM-backed AWS actions first, add P2-routed K8s later. / P2가 **단일 진입점·멱등 원장·상태 소스·UI/SSE 상관 계층** 유지 — 팀 소유 중복 0. SSM/Change Manager가 AWS 리소스 변경(초기 작업 ~80%, blast radius·감사 충실도가 가장 중요한 지점)에 관리형 승인·캘린더·감사·교차계정 제공, ADR-029 기계 ~60–70% 삭제. K8s/KEDA/앱상태/복합은 이식 가능 P2 코드 유지 — Option B의 곤란 경로와 Option C의 거버넌스 부담을 동시 해소. 점진적: SSM 기반 AWS 작업 먼저, P2 라우팅 K8s 나중.
- **Cons / 단점**: Two execution planes to correlate; two IAM patterns; routing logic in the Action Catalog must be correct (mis-routing a K8s action to SSM fails); ADR-029's six controls must be satisfied by **both** executors behind one facade. Mitigated by making the Action Catalog the single facade and P2 the single ledger (below). / 상관할 실행 평면 2개; IAM 패턴 2개; Action Catalog의 라우팅이 정확해야 함(K8s를 SSM으로 오라우팅 시 실패); ADR-029 6대 통제를 **두 실행기 모두** 하나의 facade 뒤에서 충족해야 함. Action Catalog를 단일 facade로, P2를 단일 원장으로 두어 완화(아래).

### Option E: Do nothing — stay recommendation-only — rejected baseline / 현 상태 — 권고 전용 — 기각 기준선

- **Pros / 장점**: Zero mutation blast radius / 변경 blast radius 0.
- **Cons / 단점**: Blocks ADR-032 mitigation, ADR-034 mutating write-backs, ADR-010 Phase 3 indefinitely; product value capped at read-only AI recommendations. Valid only as the interim state until D ships. / ADR-032 완화·ADR-034 변경 라이트백·ADR-010 Phase 3 무기한 차단; 제품 가치가 읽기 전용 AI 권고에 한정. D 출시 전 잠정 상태로만 유효.

## Decision / 결정

Adopt **Option D (Hybrid)**, with these load-bearing rules:

**Option D(하이브리드)**를 채택하며, 다음을 핵심 규칙으로 한다:

1. **P2 worker backbone is the single mutation control-plane and ledger.** No mutating path may start SSM (or any executor) directly outside `POST /api/jobs` → `worker_jobs`. P2 owns idempotency (execution-name == `job_id`), status, retry/reaper, and UI/SSE correlation. / **P2 워커 백본이 단일 변경 컨트롤 플레인·원장.** 어떤 변경 경로도 `POST /api/jobs` → `worker_jobs` 밖에서 SSM(또는 실행기)을 직접 시작하지 않는다. P2가 멱등(실행명 == `job_id`)·상태·재시도/reaper·UI/SSE 상관을 소유.
2. **The Action Catalog is the single facade** (ADR-029 control #1, retained). Each entry binds `executor_type ∈ {ssm, lambda, fargate}`, target IAM role / `AutomationAssumeRole`, approval template, dry-run contract, paired rollback artifact, and account/region/resource conditions. The SFN `$.runtime` Choice is extended with an SSM branch — `aws-sdk:ssm:startAutomationExecution` (**request-response; NOT a `.sync` integration** — SSM Automation is not in Step Functions' supported `.sync`/Run-a-Job set), with completion tracked via `.waitForTaskToken` resumed by an EventBridge rule on SSM Automation `status-change` (poll `getAutomationExecution` as fallback) — alongside the existing `lambda`/`fargate` branches. / **Action Catalog가 단일 facade**(ADR-029 통제 #1 보존). 각 항목은 `executor_type ∈ {ssm, lambda, fargate}`, 대상 IAM 역할/`AutomationAssumeRole`, 승인 템플릿, dry-run 계약, 페어 롤백 산출물, 계정/리전/리소스 조건을 바인딩. SFN `$.runtime` Choice에 기존 `lambda`/`fargate` 분기와 함께 SSM 분기(`aws-sdk:ssm:startAutomationExecution` — **요청-응답이며 `.sync` 아님**; SSM Automation은 SFN `.sync` 미지원 → 완료는 EventBridge `status-change`로 `.waitForTaskToken` 재개, 폴백은 `getAutomationExecution` 폴링)를 확장.
3. **AWS-resource actions → SSM Automation runbooks + Change Manager** (managed 4-eyes approval, change calendars, CloudTrail + execution-history audit, `AutomationAssumeRole` + `TargetLocations` cross-account per ADR-008). **K8s/KEDA/app-state/composite actions → P2 Lambda/Fargate** code executors. / **AWS 리소스 작업 → SSM Automation 런북 + Change Manager**; **K8s/KEDA/앱상태/복합 → P2 Lambda/Fargate** 코드 실행기.
4. **ADR-029's six controls are mandatory for both executor types** (substrate-agnostic). SSM satisfies approval/audit/rollback/cross-account natively (configure `AutoApprove=false`, Approvers ≠ requester to enforce 4-eyes); P2 code satisfies them programmatically (Task-Token approval, Choice dry-run, Catch rollback). Dry-run and the idempotency token are AWSops-enforced in both. / **ADR-029 6대 통제는 두 실행기 모두 필수**(substrate 무관). SSM은 승인/감사/롤백/교차계정을 네이티브 충족(`AutoApprove=false`, Approvers ≠ 요청자로 4-eyes 강제); P2 코드는 프로그램적 충족(Task-Token 승인, Choice dry-run, Catch 롤백). dry-run과 멱등 토큰은 양쪽 모두 AWSops가 강제.

Relationships:

| Relationship | ADR | Meaning |
|---|---|---|
| **refines / partially supersedes** | ADR-029 | Replaces ADR-029's *mechanism* (dedicated per-action Lambda + separate SFN stack) with the Hybrid substrate. ADR-029's **six controls are retained** as a substrate-agnostic controls spec both executors must satisfy. |
| **reuses** | ADR-030 / P2 worker backbone | The shipped SQS→SFN→Lambda/Fargate spine, `worker_jobs` Aurora ledger, dispatcher idempotency, and reaper become the mutation control-plane — extended with an SSM executor branch, not duplicated. |
| **extends** | ADR-008 | Cross-account mutation uses SSM `AutomationAssumeRole` + `TargetLocations` (AWS-resource) or `sts:AssumeRole` from the P2 executor (K8s/app-state). |
| **enables** | ADR-010 Phase 3 / ADR-032 / ADR-034 | Phase-3 scaling, the ADR-032 mitigation phase, and ADR-034 mutating write-backs all route through this substrate (still recommendation-only by default; execution is gated). |
| **relates** | ADR-015 / ADR-023 | Reuses the FinOps MCP Lambda pattern for action executors; reuses the `adminEmails` admin gate for plan creation. |

ADR-036 is itself a **mutating-capability decision** and remains gated: execution stays recommendation-only by default until the catalog + controls are in place (the ADR-029 premise, preserved).

ADR-036 자체가 **변경 역량 결정**이며 게이트 유지: 카탈로그 + 통제가 갖춰질 때까지 실행은 기본 권고 전용(ADR-029 전제 보존).

## Consequences / 영향

### Positive / 긍정적
- No team-owned orchestration duplication — one spine (P2) for async jobs and mutations, one ledger, one set of dashboards/alarms. / 팀 소유 오케스트레이션 중복 0 — 비동기 작업·변경에 단일 spine(P2)·단일 원장·단일 대시보드/알람.
- Managed governance where it matters most: Change Manager + CloudTrail give stronger, lower-effort approval/audit/cross-account for AWS-resource mutations than hand-rolled code (~60–70% of ADR-029 machinery deleted). / 가장 중요한 곳에 관리형 거버넌스: Change Manager + CloudTrail가 AWS 리소스 변경에 수제 코드보다 강하고 적은 노력의 승인/감사/교차계정 제공(ADR-029 기계 ~60–70% 삭제).
- K8s/app-state actions keep portable, testable code paths — no forcing kubectl through SSM. / K8s·앱상태 작업은 이식·테스트 가능 코드 경로 유지 — kubectl을 SSM으로 강제하지 않음.
- ADR-029 simplifies to a controls spec, decoupling governance from implementation. / ADR-029가 통제 사양으로 단순화 — 거버넌스를 구현에서 분리.

### Negative / 부정적
- Two execution planes to operate and correlate (SSM executions + P2 Lambda/Fargate). Mitigation: P2 is the single ledger; the SFN writes the `AutomationExecutionId` to the `worker_jobs` row **immediately on start**, an EventBridge rule on SSM Automation `status-change` (poll fallback) updates terminal status, and the reaper reconciles stuck rows — so a SFN timeout cannot orphan a running automation. / 운영·상관할 실행 평면 2개. 완화: P2가 단일 원장; SFN이 시작 **즉시** `AutomationExecutionId`를 `worker_jobs` 행에 기록, SSM Automation `status-change` EventBridge 규칙(폴백 폴링)이 종료 상태 갱신, reaper가 stuck 행 정합화 — SFN 타임아웃이 실행 중 automation을 고아로 만들지 않음.
- Routing correctness risk (catalog binds the wrong `executor_type`). Mitigation: catalog entry is code-reviewed; dry-run runs on the resolved executor before execute. / 라우팅 정확성 위험. 완화: 카탈로그 항목 코드 리뷰; 해석된 실행기에서 execute 전 dry-run.
- AWS lock-in for the SSM portion (gemini's dissent). Accepted: AWSops is explicitly AWS-only / customer-VPC; portability is not a product goal. Business logic for non-AWS actions stays in portable P2 code. / SSM 부분의 AWS 락인(gemini 이견). 수용: AWSops는 명시적 AWS-only/customer-VPC; 이식성은 제품 목표 아님. 비-AWS 작업 로직은 이식 가능 P2 코드 유지.
- SSM runbook versioning is not Git-native and dry-run is partial for some APIs. Mitigation: a thin Git→SSM Document sync in deploy; the catalog's dry-run contract enforces a check mode where native `--dry-run` is absent. / SSM 런북 버저닝 비-Git-native, 일부 API dry-run 부분 지원. 완화: 배포에 Git→SSM Document 동기화; 네이티브 `--dry-run` 부재 시 카탈로그 dry-run 계약이 check 모드 강제.

### Post-acceptance deviations / 채택 후 편차
- None yet. / 아직 없음.

## Consensus Review Addenda (2026-06-09) / 합의 리뷰 보완

Multi-AI consensus review (codex/gemini/kiro, Claude chair) returned ACCEPT-WITH-CHANGES. Resolved:

멀티AI 합의 리뷰(codex/gemini/kiro, Claude 의장) 결과 ACCEPT-WITH-CHANGES. 반영:

1. **`.sync` factual error (kiro MAJOR, verified)** — SSM Automation is not a Step Functions `.sync` integration. Corrected to request-response + `.waitForTaskToken`/EventBridge `status-change` completion tracking (Decision rule 2 + Negative consequences above). / SSM Automation은 SFN `.sync` 미지원 → 요청-응답 + `.waitForTaskToken`/EventBridge 완료추적으로 정정.
2. **Approval-identity model (kiro MAJOR)** — AWSops is the automated *requester*; **approvers must be human IAM principals in the customer account** holding the Change Manager approver role + `ssm:SendAutomationSignal`. The 4-eyes invariant is enforced by the Change Manager template (`AutoApprove=false`, approver set **excludes** the AWSops principal). For the P2-code path, Task-Token approval is delivered to the same admin set (ADR-023) via the dashboard/Slack, with an expiry that fails closed. / AWSops는 자동 요청자; **승인자는 고객 계정의 사람 IAM 주체**(Change Manager 승인자 역할 + `ssm:SendAutomationSignal`). 4-eyes는 템플릿(`AutoApprove=false`, 승인자에서 AWSops 주체 제외)으로 강제. P2 코드 경로는 Task-Token 승인을 동일 admin(ADR-023)에 전달, 만료 시 fail-closed.
3. **Per-action IAM for BOTH executors (kiro MINOR)** — SSM uses one `AutomationAssumeRole` per runbook; **P2 code executors get a per-action task role (NOT a shared worker role)** to prevent one action's executor calling another's APIs. The dispatcher only invokes/runs approved, catalog-pinned executors. / SSM은 런북당 `AutomationAssumeRole`; **P2 코드 실행기는 작업당 task role(공유 워커 역할 금지)** — 권한 상승 방지.
4. **Control → substrate mapping (kiro MINOR — substantiate "~60–70%")**:

   | ADR-029 control | SSM executor | P2-code executor |
   |---|---|---|
   | 1. Per-action IAM | `AutomationAssumeRole`/runbook (native) | per-action task role (built) |
   | 2. Mandatory dry-run | partial native (`--dry-run`/Describe) + catalog check-mode | SFN Choice dry-run (built) |
   | 3. 4-eyes approval | Change Manager template (native) | Task-Token + admin set (built) |
   | 4. Paired rollback | runbook `onFailure`/`onCancel` (native, authored) | SFN Catch → rollback plan (built) |
   | 5. Three audit sinks | CloudTrail + SSM execution history (native, exceeds) | CloudTrail + `worker_jobs` + log sink (built) |
   | 6. Idempotency token | enforced by P2 `job_id` (single front-door) | enforced by P2 `job_id` |

   → SSM natively covers controls 3 + 5 and most of 1/4 for AWS-resource actions (the deleted ~60–70%); the catalog, dry-run contract, idempotency, the web→SSM bridge, and the entire P2-code path remain AWSops-built (~30–40%).
5. **ADR-034 low-risk observability writes (kiro MINOR)** — an OpsItem creation is a single API call; it routes through the **P2 `lambda` executor with ADR-034's reduced "observability-write" control subset**, NOT a full SSM remediation runbook (over-engineered) and NOT bypassing governance. Change-Manager approval applies only to the infrastructure-mutation tier. / OpsItem 생성은 단일 API 호출 → **P2 `lambda` 실행기 + ADR-034의 축소 "observability-write" 통제 부분집합**으로 라우팅(전체 SSM 런북은 과설계). Change Manager 승인은 인프라 변경 tier에만.

## References / 참고 자료
- ADR-029 (mutating-action framework — mechanism refined here, controls retained), ADR-030 (ECS/Aurora + P2 backbone), ADR-008 (multi-account assume-role), ADR-010 (event pre-scaling Phase 3), ADR-032 (autonomous incident lifecycle mitigation), ADR-034 (alert auto-RCA write-back), ADR-015 (FinOps MCP Lambda), ADR-023 (admin gate)
- AWS Systems Manager Automation — https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-automation.html
- AWS Systems Manager Change Manager — https://docs.aws.amazon.com/systems-manager/latest/userguide/change-manager.html
- SSM Automation multi-account/Region (`TargetLocations`, `AutomationAssumeRole`) — https://docs.aws.amazon.com/systems-manager/latest/userguide/running-automations-multiple-accounts-regions.html
- Step Functions `aws-sdk` service integration (`ssm:startAutomationExecution`) — https://docs.aws.amazon.com/step-functions/latest/dg/supported-services-awssdk.html
- Co-authored via `/co-agent` ADR mode; alternatives/risks cross-reviewed by codex, gemini, kiro-cli (Claude as chair). Consensus: Hybrid + reuse-P2 + ADR-029-as-controls-spec; dissent: gemini preferred pure-code Option C (recorded above).
