# ADR-034: Alert Auto-RCA Write-Back (Bidirectional Incident Enrichment) / 알림 자동 RCA 라이트백 (양방향 인시던트 보강)

## Status / 상태

Accepted (2026-06-09) / 채택 (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES, codex/gemini/kiro). 피드백루프 차단 메커니즘 + observability-write 통제 부분집합 정의 + best-effort 비차단 + OpsCenter/Incident Manager 라우팅 규칙 보완 (§Post-acceptance 2026-06-09 참조).

> **✅ KEPT — but decoupled from the reversed substrate (2026-06-11, 3-AI consensus reversal)** — ADR-034 was **kept** (observability-metadata write = low blast radius; see `docs/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`). However the bodies below say write-back is "**governed by the ADR-029 gate**" and executed via the **ADR-036** substrate — **both are now REVERSED**. Re-read those references as: ADR-034's OpsItem/Incident-Manager write is a **low-risk observability-write** governed by its *own* control subset (this ADR's 2026-06-09 addendum: scoped IAM `ssm:CreateOpsItem`/`ssm-incidents:*`, admin gate, audit, idempotency/dedup, body-render "dry-run", resolve/annotate "rollback"). Its execution path does **not** traverse the ADR-036 mutating executor (it is a dedicated Lambda stage holding the single `ssm:CreateOpsItem` permission). **However, the current implementation still reuses the frozen ADR-029/036 substrate's IAM role** (`action_opscenter_write`, `count = remediation_enabled` in `remediation.tf`). Consequently, turning this KEPT feature on today also requires the do-not-enable `remediation_enabled` flag — so **activating write-back first requires decoupling it onto a self-contained role** (the plan-time `[0]` index acts as a fail-loud guard, enforced by a `rca_writeback_enabled` validation in `variables.tf`). Cross-account write-back via ADR-036 `TargetLocations` (Account-boundary caveat below) is **moot** → **host-account only**. ADR-034 itself remains built **flag-OFF**; KEPT as a valid future capability, not part of the abandoned mutation/autonomy tier. / 위 참조는 다음으로 재해석: 034의 OpsItem/IM write는 **자체 통제 부분집합**(스코프 IAM·admin 게이트·감사·멱등·본문렌더 dry-run·OpsItem 해제 rollback)으로 통제되는 **저위험 observability-write**이며, 실행 경로는 ADR-036 mutating executor를 거치지 않는다(전용 Lambda 스테이지 + `ssm:CreateOpsItem` 단일 권한). **다만 현재 구현은 frozen 029/036 substrate의 IAM role(`action_opscenter_write`, `count = remediation_enabled`, `remediation.tf`)을 재사용**한다. 따라서 이 KEPT 기능을 지금 켜려면 do-not-enable인 `remediation_enabled`까지 필요 — **활성화하려면 먼저 자족 role로 분리하는 선행 작업이 필요**하다(plan-time `[0]` 인덱스가 fail-loud 가드 역할, `variables.tf`의 `rca_writeback_enabled` validation이 강제). 036 `TargetLocations` 교차계정은 **무효 → host 계정 전용**. 034는 flag-OFF로 유지.

This ADR records the *output-channel* decision for autonomous diagnosis: **where** an AI root-cause analysis lands. It makes the alert pipeline's output **bidirectional** — writing the RCA back onto the originating alert/incident record — mirroring how AWS DevOps Agent posts findings back to the finding/console rather than only emitting a one-way message.

본 ADR은 자율 진단의 *출력 채널* 결정을 기록한다: AI 근본 원인 분석(RCA)이 **어디에** 도달하는가. 알림 파이프라인 출력을 **양방향**으로 만든다 — RCA를 발생 알림/인시던트 레코드에 다시 기록 — AWS DevOps Agent가 단방향 메시지만 보내는 대신 finding/콘솔에 결과를 되돌려 게시하는 방식을 차용한다.

## Context / 컨텍스트

Today the alert pipeline is a one-way street. `alert-webhook/route.ts` (ADR-022 HMAC) ingests CloudWatch SNS / Alertmanager / Grafana / generic events → `alert-correlation.ts` groups/dedups them → `alert-diagnosis.ts` runs Bedrock RCA (ADR-009, to be superseded by the ADR-032 lifecycle once ADR-032 is Accepted) → output goes **only to Slack/SNS** (ADR-012). A code audit confirms there is **no write-back to any source alert or incident system**: `slack-notification.ts` already supports incident threads (`sendSlackResolvedUpdate(threadTs)`, `thread_ts` in payloads), but there is **zero** OpsCenter / Incident Manager / external-ITSM integration. The RCA stays detached from the alarm/incident the responder is actually looking at.

현재 알림 파이프라인은 일방통행이다. `alert-webhook/route.ts`(ADR-022 HMAC)가 CloudWatch SNS / Alertmanager / Grafana / generic 이벤트를 수신 → `alert-correlation.ts`가 그룹화·중복제거 → `alert-diagnosis.ts`가 Bedrock RCA 실행(ADR-009, ADR-032가 Accepted되면 라이프사이클로 승계 예정) → 출력은 **Slack/SNS로만**(ADR-012) 나간다. 코드 감사 결과 **어떤 소스 알림·인시던트 시스템에도 라이트백이 없다**: `slack-notification.ts`는 인시던트 스레드(`sendSlackResolvedUpdate(threadTs)`, payload의 `thread_ts`)를 이미 지원하나, OpsCenter / Incident Manager / 외부 ITSM 연동은 **전무**하다. RCA가 응답자가 실제로 보는 알람/인시던트와 분리돼 있다.

The motivating request: when an alert fires, AWSops should automatically run RCA and **register the result back onto the alert/incident**, so responders see the analysis where they already work. This is the bidirectional *output* of the ADR-032 lifecycle (Triage → investigate → RCA), which ADR-032 itself does not pin down. This decision was cross-reviewed by codex and gemini (kiro-cli did not consume the piped context this round); both independently recommended an **AWS-native write-back default plus a persistent Slack thread**, severity-gated and dedup-first.

동기가 된 요청: 알림이 발생하면 AWSops가 자동으로 RCA를 실행하고 **결과를 알림/인시던트에 다시 등록**해, 응답자가 일하던 곳에서 분석을 보게 한다. 이는 ADR-032 라이프사이클(Triage → 조사 → RCA)의 양방향 *출력*이며, ADR-032 자체는 이를 확정하지 않는다. 본 결정은 codex와 gemini의 교차 검토를 받았고(kiro-cli는 이번 회차 파이프 컨텍스트 미수신), 둘 다 독립적으로 **AWS-네이티브 라이트백 기본 + 영속 Slack 스레드**(심각도 게이트·dedup 우선)를 권고했다.

## Options Considered / 고려한 대안

### Option 1: AWS-native write-back (OpsCenter / Incident Manager) + persistent Slack thread — chosen / AWS-네이티브 라이트백(OpsCenter / Incident Manager) + 영속 Slack 스레드 — 채택

Correlate and dedup first; run RCA **once per deduped incident** (severity-gated); then create/update an SSM **OpsCenter OpsItem** or **Incident Manager** incident in the customer account with the RCA, a confidence score, evidence links, the investigation timeline, and a recommendation — labelled "AWSops recommendation," not an authoritative root cause. Maintain one Slack thread per incident (reuse existing `threadTs`) as the secondary, chat-ops channel. External ITSM (PagerDuty/ServiceNow/Grafana annotations) are **optional adapters** added later, behind the same gate.

먼저 상관·중복제거; **deduped 인시던트당 1회** RCA 실행(심각도 게이트); 이후 고객 계정에 SSM **OpsCenter OpsItem** 또는 **Incident Manager** 인시던트를 생성/갱신해 RCA·신뢰도 점수·근거 링크·조사 타임라인·권고를 기록 — 권위 있는 근본 원인이 아니라 "AWSops 권고"로 표기. 인시던트당 Slack 스레드 1개(기존 `threadTs` 재사용)를 보조 chatops 채널로 유지. 외부 ITSM(PagerDuty/ServiceNow/Grafana 주석)은 동일 게이트 뒤에서 나중에 추가하는 **선택적 어댑터**.

- **Pros / 장점**: Best fit for an AWS-only, customer-VPC product — stays inside customer IAM/CloudTrail/VPC endpoints, no external credentials by default. Produces a durable incident object the ADR-032 lifecycle can enrich across stages. Reuses `alert-correlation`/`alert-diagnosis`/`alert-knowledge` and the existing Slack threading; adds adapters, not a rebuild. / AWS-only·customer-VPC 제품에 최적 — 고객 IAM/CloudTrail/VPC 엔드포인트 내부에 머물고 기본적으로 외부 자격증명 없음. ADR-032 라이프사이클이 단계별로 보강할 수 있는 내구성 인시던트 객체를 생성. `alert-correlation`/`alert-diagnosis`/`alert-knowledge`와 기존 Slack 스레딩을 재사용 — 재구축이 아니라 어댑터 추가.
- **Cons / 단점**: Requires AWS **write** permissions (OpsCenter/Incident Manager) and therefore ADR-029 classification, even though AWSops stays recommendation-only. CloudWatch alarms have no rich native annotation model, so OpsCenter/Incident Manager becomes the canonical target — teams living purely in Slack/PagerDuty get the secondary thread, not their primary tool, until adapters ship. / AWS **write** 권한(OpsCenter/Incident Manager)이 필요하고 따라서 ADR-029 분류 대상이다(AWSops는 권고 전용 유지에도 불구). CloudWatch 알람은 풍부한 네이티브 주석 모델이 없어 OpsCenter/Incident Manager가 표준 타깃이 된다 — Slack/PagerDuty만 쓰는 팀은 어댑터 출시 전까지 기본 도구가 아닌 보조 스레드를 받는다.

### Option 2: Status quo — one-way Slack/SNS — rejected / 현 상태 — 단방향 Slack/SNS — 기각

Keep ADR-012 behavior; RCA only in Slack/`alert-knowledge`. / ADR-012 동작 유지; RCA는 Slack/`alert-knowledge`에만.

- **Pros / 장점**: Zero new state, permissions, or ITSM work; lowest security risk. / 신규 상태·권한·ITSM 작업 0; 보안 위험 최소.
- **Cons / 단점**: RCA stays detached from the alarm/incident; responders reconcile Slack with consoles manually; repeated alerts fragment context; no durable record for the ADR-032 lifecycle to enrich. Meets none of the motivating requirement. / RCA가 알람/인시던트와 분리; 응답자가 Slack과 콘솔을 수동 대조; 반복 알림이 컨텍스트를 분절; ADR-032가 보강할 내구성 레코드 없음. 동기 요구를 충족하지 못함.

### Option 3: Slack-thread-only enrichment — rejected / Slack 스레드 전용 보강 — 기각

Maintain one rich Slack incident thread per deduped group; never write to AWS/ITSM. / deduped 그룹당 풍부한 Slack 인시던트 스레드 1개 유지; AWS/ITSM에는 미기록.

- **Pros / 장점**: Smallest mutation surface; reuses the current notification path; good chatops timeline. / 변경 표면 최소; 기존 알림 경로 재사용; 좋은 chatops 타임라인.
- **Cons / 단점**: Makes Slack the system-of-record for an AWS-native product; weak auditability; data lost if the channel is archived; useless to teams working from CloudWatch/Incident Manager/Grafana/ITSM consoles. / AWS-네이티브 제품의 시스템-of-record를 Slack으로 만든다; 감사성 약함; 채널 보관 시 데이터 소실; CloudWatch/Incident Manager/Grafana/ITSM 콘솔 사용 팀에 무용.

### Option 4: External ITSM bidirectional write-back as the default — rejected / 외부 ITSM 양방향 라이트백을 기본으로 — 기각

Default to writing back into PagerDuty/ServiceNow/Opsgenie/Grafana. / PagerDuty/ServiceNow/Opsgenie/Grafana로의 라이트백을 기본으로.

- **Pros / 장점**: Best ergonomics where teams already live in external tools. / 외부 도구를 쓰는 팀에 최적 사용성.
- **Cons / 단점**: Explodes adapter surface, auth models, rate limits, secret management, and per-vendor failure modes; breaks the AWS-only/customer-VPC default posture; every external mutation needs the ADR-029 gate. Correct as *optional adapters after* the AWS-native path is stable, not as the default. / 어댑터 표면·인증 모델·레이트 리밋·시크릿 관리·벤더별 실패 모드가 폭증; AWS-only/customer-VPC 기본 자세를 깨뜨림; 외부 변경마다 ADR-029 게이트 필요. AWS-네이티브 경로 안정화 *이후 선택적 어댑터*로는 적합하나 기본값으로는 부적합.

### Option 5: State-backed incident-enrichment service now (on single-EC2) — rejected / 상태 기반 인시던트 보강 서비스 즉시 도입(단일 EC2) — 기각

Build a durable incident-identity/dedup/write-back-status store now. / 내구성 인시던트 식별·dedup·라이트백 상태 저장소를 지금 구축.

- **Pros / 장점**: Strongest idempotency/correctness story. / 멱등성·정확성 최강.
- **Cons / 단점**: Couples ADR-034 to a storage migration instead of the write-back behavior; durable identity belongs on the v2 Aurora layer (ADR-030), not single-EC2 node-cache. Build the behavior now with conservative best-effort dedup; move identity to Aurora in v2. / 라이트백 동작이 아니라 스토리지 마이그레이션에 ADR-034를 결합; 내구성 식별은 단일 EC2 node-cache가 아닌 v2 Aurora 계층(ADR-030) 소관. 지금은 보수적 best-effort dedup으로 동작을 구축하고 v2에서 식별을 Aurora로 이전.

## Decision / 결정

Adopt **Option 1**. Relationships:

**Option 1**을 채택한다. 관계:

| Relationship | ADR | Meaning |
|---|---|---|
| **extends** | ADR-032 | The autonomous lifecycle produces the RCA; ADR-034 is its bidirectional **output/enrichment** channel (write-back to the source incident record). ADR-032 (**Accepted 2026-06-09**) **supersedes** ADR-009; ADR-034 builds on the ADR-032 lifecycle's RCA (the ADR-009 correlation engine carried into ADR-032's Triage). |
| **extends** | ADR-012 | Notification evolves from one-way Slack/SNS to bidirectional write-back + one persistent Slack incident thread per deduped incident (reuses `slack-notification.ts` `threadTs`). |
| **extends** | ADR-029 | Write-back to OpsCenter/Incident Manager/Grafana/ITSM is a **mutating action on the observability plane** → governed by ADR-029, as a **lower-risk "observability-metadata write" tier** distinct from infrastructure mutation. Annotate/create/update is the default; **silences are higher-risk and separately gated**. ⚠️ **Account-boundary caveat (updated 2026-06-10)**: the original host-account-only restriction is **no longer an architectural lock** — ADR-029's §Consensus Revision #7 reframed it as a **toggle** (`ALLOW_CROSS_ACCOUNT_MUTATION`, default `false`), and **ADR-036** enables member-account execution via SSM `TargetLocations`/`AutomationAssumeRole` (or `sts:AssumeRole` from a P2 executor) per ADR-008. So cross-account write-back is now gated by a **default-off toggle**, not blocked pending a "future ADR." Default posture remains host-account-only until the toggle is explicitly enabled. |
| **extends** | ADR-022 | Reuses the HMAC-authenticated webhook as the trigger entry point. |
| **relates** | ADR-030 | Durable incident identity, dedup keys, write-back status, source object IDs, and RCA versions persist in the v2 Aurora layer; v1 uses best-effort `node-cache` with conservative dedup windows. |
| **relates** | ADR-033 | Reuses cost controls — dedup-before-diagnose, severity gating, and prompt/answer caching — to bound alert-storm token spend; cites `alert-knowledge` similarity before re-invoking Bedrock. |
| **relates** | ADR-018 / ADR-008 | Per-account/tenant isolation; least-privilege write scope to OpsCenter/Incident Manager in the customer account only. |

Default posture is **recommendation-only**: write-backs are labelled as AWSops recommendations with confidence, evidence, timestamp, data sources, and RCA/model/prompt versions — never an unqualified "confirmed root cause."

기본 자세는 **권고 전용**이다: 라이트백은 신뢰도·근거·타임스탬프·데이터 소스·RCA/모델/프롬프트 버전과 함께 AWSops 권고로 표기되며, 무조건적 "확정 근본 원인"으로 표기하지 않는다.

## Consequences / 영향

### Positive / 긍정적
- RCA appears on the incident responders actually work from (OpsCenter/Incident Manager), with a Slack timeline — the DevOps-Agent-style "analysis already done when you arrive" experience. / RCA가 응답자가 실제로 일하는 인시던트(OpsCenter/Incident Manager)에 Slack 타임라인과 함께 표시 — "도착하면 분석이 이미 끝나 있는" DevOps-Agent식 경험.
- Produces a durable, auditable incident object the ADR-032 lifecycle and `alert-knowledge` can enrich and learn from across re-fires. / ADR-032 라이프사이클과 `alert-knowledge`가 재발 시 보강·학습할 수 있는 내구성·감사 가능 인시던트 객체 생성.
- Stays AWS-native by default — no external credentials, fits customer-VPC/governance. / 기본적으로 AWS-네이티브 — 외부 자격증명 없음, customer-VPC/거버넌스에 부합.

### Negative / 부정적
- A confidently-wrong RCA written onto an "official" incident can mislead responders under pressure. Mitigation: recommendation labelling + confidence + evidence; cite `alert-knowledge` priors as supporting context, not proof. / 그럴듯하게 틀린 RCA가 "공식" 인시던트에 기록되면 압박 상황의 응답자를 오도할 수 있다. 완화: 권고 표기 + 신뢰도 + 근거; `alert-knowledge` 사전 사례는 증명이 아닌 보조 컨텍스트로 인용.
- **Feedback-loop risk**: writing to OpsCenter/CloudWatch could itself raise an alarm → infinite analysis loop. Mitigation: exclude AWSops's own write-backs from ingestion; loop-breaker on incident source. / **피드백 루프 위험**: OpsCenter/CloudWatch 기록 자체가 알람을 유발 → 무한 분석 루프. 완화: AWSops 자체 라이트백을 수신에서 제외; 인시던트 소스에 루프 차단기.
- **Staleness**: an alert may resolve while RCA is still running → writing "Investigating" to a closed incident. Mitigation: dedup window + status reconciliation before write. / **Staleness**: RCA 진행 중 알림이 해소될 수 있다 → 닫힌 인시던트에 "조사 중" 기록. 완화: 기록 전 dedup 윈도 + 상태 정합화.
- **Prompt injection**: alert payloads are attacker-controllable. Mitigation: treat alert text as untrusted data; it must never influence tool permissions or policy; least-privilege write scope. / **프롬프트 인젝션**: 알림 payload는 공격자 제어 가능. 완화: 알림 텍스트를 신뢰 불가 데이터로 취급; 도구 권한·정책에 영향 금지; 최소 권한 write 범위.
- **Cost / alert storms**: RCA on every alert spikes tokens. Mitigation: dedup-before-diagnose, severity gating by default, reuse ADR-033 caching + `alert-knowledge`, incremental summary on re-fire rather than full RCA regeneration. / **비용 / 알림 스톰**: 알림마다 RCA는 토큰 급증. 완화: 진단 전 dedup, 기본 심각도 게이트, ADR-033 캐싱 + `alert-knowledge` 재사용, 재발 시 전체 RCA 재생성 대신 증분 요약.
- **Operational complexity / idempotency**: retries, partial failures, source object IDs, reconciliation. v1 node-cache is fragile for durable identity (acceptable best-effort only); durable home is v2 Aurora. / **운영 복잡성 / 멱등성**: 재시도·부분 실패·소스 객체 ID·정합화. v1 node-cache는 내구성 식별에 취약(best-effort만 허용); 내구성 거처는 v2 Aurora.

### Post-acceptance deviations / 채택 후 편차
- None yet. / 아직 없음.
- **2026-06-03 (co-agent 3-AI review)**: clarified two cross-ADR points before any implementation — (1) customer-account incident write-back is **gated behind ADR-029 lifting its v1 host-only restriction**; v1 is host-account-only (Gemini/Codex flagged the boundary breach). (2) ADR-009 is **not yet superseded** — ADR-032 is still Proposed, so the "supersedes/superseded" language was softened to "will supersede once Accepted." / **2026-06-03 (co-agent 3-AI 리뷰)**: 구현 전 두 가지 교차-ADR 사항 명확화 — (1) 고객 계정 인시던트 라이트백은 **ADR-029의 v1 host-only 제약 해제 이후로 게이트**, v1은 host 계정 전용. (2) ADR-009는 **아직 승계되지 않음** — ADR-032가 Proposed이므로 "승계" 표현을 "Accepted 시 승계 예정"으로 완화.

- **2026-06-09 (co-agent consensus review, ACCEPT-WITH-CHANGES)**:
  - **Feedback-loop = concrete mechanism** (gemini + kiro MAJOR, was "intent"): every write-back carries a marker — OpsItem `OperationalData`/tag `CreatedBy=AWSops-AIOps` (and an equivalent `source` attribute on Incident Manager / Grafana annotations); the `alert-webhook` ingress **drops any event bearing the marker**; circuit-breaker = marker-filter **plus** a max-concurrent-RCA cap. This is a testable mechanism, not "exclude from ingestion." / 모든 라이트백에 마커 부여 → 인그레스가 마커 포함 이벤트 drop + 최대 동시 RCA 캡. 의도가 아닌 테스트 가능 메커니즘.
  - **"observability-write" control subset defined** (kiro MAJOR): of ADR-029's six controls this tier applies #1 per-action IAM (scoped to `ssm:CreateOpsItem`/`ssm-incidents:*`), #3 admin gate (single-operator OK — **no 4-eyes** for a metadata note), #5 audit, #6 idempotency (dedup key); #2 dry-run = **render the OpsItem/incident body for review** (no mutation sim); #4 rollback = **resolve/annotate the OpsItem** (no infra revert). Implementers neither skip controls nor apply them absurdly. / 6대 통제 중 #1/#3(4-eyes 면제)/#5/#6 적용, #2 dry-run=본문 렌더, #4 롤백=OpsItem 해제/주석.
  - **Best-effort, non-blocking** (gemini MINOR): write-back is a separate branch; an IAM/throttle failure MUST NOT block the primary Slack/SNS notification (ADR-012). / 라이트백 실패가 1차 Slack/SNS 알림을 막지 않음(별도 분기).
  - **OpsCenter vs Incident Manager routing rule** (kiro MINOR, resolves the "or"): if an Incident Manager response plan matches the alarm → enrich that incident (`ssm-incidents`); otherwise create an OpsItem (`ssm:CreateOpsItem`). / IM 응답계획 매칭 시 인시던트 보강, 아니면 OpsItem 생성.
  - **v1 dedup-restart limitation** (kiro MINOR): a process restart loses in-process dedup; mid-storm this re-triggers RCA per alert. Bounded in v1 by the max-concurrent-RCA cap (+ optional file-backed dedup log); durable identity moves to v2 Aurora. / 재시작 시 dedup 소실 → v1은 동시 RCA 캡으로 한정, v2 Aurora로 내구화.
  - **Prompt-injection into RCA *content*** (kiro MINOR): beyond not influencing permissions, a crafted payload could manipulate the RCA *text* written to an incident. Mitigation: structured prompt isolation (alert text in a fenced, clearly-labelled data block) + an output sanity-check before write-back. / 권한뿐 아니라 RCA 본문 조작 가능 → 알림 텍스트 펜스 격리 + 출력 검증.
  - ADR-009/032 supersession wording: already softened in the 2026-06-03 entry (builds on the ADR-032 diagnosis model; 009 superseded once 032 Accepted). / 승계 표현은 2026-06-03 항목에서 이미 완화됨.

## References / 참고 자료
- ADR-032 (autonomous incident lifecycle), ADR-009 (alert-triggered diagnosis, superseded), ADR-012 (SNS/Slack notification), ADR-029 (mutating-action framework), ADR-022 (webhook HMAC), ADR-030 (ECS/Aurora split), ADR-033 (AIOps LLM cost optimization)
- AWS Systems Manager OpsCenter — https://docs.aws.amazon.com/systems-manager/latest/userguide/OpsCenter.html
- AWS Systems Manager Incident Manager — https://docs.aws.amazon.com/incident-manager/latest/userguide/what-is-incident-manager.html
- AWS DevOps Agent — Autonomous incident response — https://docs.aws.amazon.com/devopsagent/latest/userguide/working-with-devops-agent-autonomous-incident-response.html
- Co-authored via `/co-agent` ADR mode; alternatives/risks cross-reviewed by codex and gemini (kiro-cli unavailable this round); Claude as chair.
