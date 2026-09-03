# ADR-019: SG Rules Athena 활동 파이프라인 — ADR-005에 대한 owner-override 예외 / SG Rules Athena Activity Pipeline — an Owner-Override Exception to ADR-005

## Status / 상태

**Accepted (2026-08-19) — GATED(owner-override 예외), ADR-015 패턴.**

- **Owner:** 오준석(Junseok Oh) — `/co-agent:consensus` 세션에서 이 ADR 초안 작성과 멀티-AI 패널 리뷰를
  지시했고, 최종 결정을 승인했다. SG-Rules spec이 요구한 "새 ADR + 멀티-AI 패널 + 날짜박힌
  owner-override"(ADR-015 절차)를 충족한다.
- **패널:** codex·kiro-cli·kiro-opus·kiro-gpt를 포함한 멀티-AI 패널이 3라운드에 걸쳐 이 ADR과 두
  spec의 Approved 승격을 리뷰했다. 라운드별 세부 발견·수정 이력은 PR #230 토론에 보존되어 있다 — 이
  문서는 그 이력을 재서술하지 않고 최종 확정된 결정만 기록한다(`docs/decisions/CLAUDE.md`의 "번복
  체인 서술 금지" 규칙).
- 이 ADR은 `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`가 "새 ADR을
  통해서만 해소된다"고 명시한 ADR-005/ADR-007 분류 질문을 다룬다.

**Accepted (2026-08-19) — GATED(owner-override exception), ADR-015 pattern.**

- **Owner:** 오준석(Junseok Oh) — directed drafting this ADR and the multi-AI panel review inside a
  `/co-agent:consensus` session, and approved the final decision. Satisfies the "new ADR + multi-AI
  panel + dated owner-override" instrument (the ADR-015 procedure) the SG-Rules spec required.
- **Panel:** a multi-AI panel (codex, kiro-cli, kiro-opus, kiro-gpt) reviewed this ADR and both
  specs' Approved promotion across 3 rounds. Round-by-round findings and fixes are preserved in the
  PR #230 discussion — this document states only the final settled decision, not that history (per
  `docs/decisions/CLAUDE.md`'s "no reversal-chain narration" rule).
- This ADR resolves the ADR-005/ADR-007 classification question that
  `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md` states can only be
  settled by a new ADR.

## Context / 컨텍스트

`docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`가 규정하는 SG Rules 기능(일일
`DescribeSecurityGroupRules`/`DescribeNetworkInterfaces` 인벤토리 + Athena 기반 90일 트래픽 증거
파이프라인)은 오늘 코드베이스에 없는 두 가지 능력이 필요하다: (1) 대상 계정의 rule 인벤토리를 읽기
위한 cross-account 접근(P2 워커 role인 `worker_task`/`worker_lambda`는 현재 어떤 cross-account grant도
갖고 있지 않다), (2) Athena를 통한 Flow Log 조회 + 워크그룹 결과 prefix로의 S3 write. spec은 (2)를
"ADR-007-tier"(외부 DATA write)로 자체 분류했으나, 그 분류가 spec 저자 본인의 추론일 뿐 비준된 결정이
아님을 spec 스스로 인정했다.

The SG Rules feature (`docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`) — a
daily rule-inventory scan plus an Athena-based 90-day traffic-evidence pipeline — needs two
capabilities the codebase does not have today: (1) cross-account access to read rule inventory in
onboarded target accounts (the P2 worker roles, `worker_task`/`worker_lambda`, currently hold zero
cross-account grant), and (2) Athena-based Flow Log querying plus an S3 write to a workgroup result
prefix. The spec self-classified (2) as "ADR-007-tier" (external DATA write) but flagged that
classification as its own unratified reasoning, not a decision.

## Analysis / 분석

### 1. Athena/Glue/S3는 ADR-007의 "외부 DATA"가 아니라 AWS-네이티브 서비스다

ADR-007의 "외부 DATA"는 AWS 계정 경계를 넘어서는 제3자 SaaS(Slack, Notion, Jira, 외부 관측성
플랫폼)를 가리킨다. Athena·Glue·S3는 고객이 이미 온보딩한 **같은 AWS 계정 안의** AWS 네이티브
서비스이며, 이들에 대한 read-query 호출은 `DescribeSecurityGroupRules`나 CloudWatch Logs Insights와
동일한 신뢰 경계 안에 있다. 이 결론은 아래 두 role 모두에 적용된다 — ADR-007 티어는 필요 없다.

ADR-007's "external DATA" means third-party SaaS outside the AWS account boundary (Slack, Notion,
Jira, external observability platforms). Athena, Glue, and S3 are AWS-native services **inside the
same already-onboarded AWS account** — read-query calls against them sit inside the same trust
boundary as `DescribeSecurityGroupRules` or CloudWatch Logs Insights. This conclusion applies to
both roles below — neither needs an ADR-007-tier classification.

### 2. 이 형태의 비동기 조회 패턴은 이미 라이브다

`web/lib/dns-logs.ts`, `web/lib/anfw-logs.ts`, `web/lib/sg-analysis.ts`는 이미 CloudWatch Logs
Insights의 `StartQueryCommand` → 폴링 → `GetQueryResultsCommand`(+ 데드라인 시 `StopQueryCommand`)로
로그 데이터를 비동기 조회한다 — 어떤 ADR-005/007 논쟁도 거치지 않고 라이브다. **`sg-analysis.ts`
(`web/lib/sg-analysis.ts:572-585`)가 가장 강한 선례다** — 바로 이 기능이 확장하는 동일한 데이터(VPC
Flow Logs)를 동일한 목적(SG rule 매칭)으로 조회한다. Athena의 `StartQueryExecution` → 폴링 →
`GetQueryResults`(+ `StopQueryExecution`)는 구조적으로 동일한 패턴이다 — 유일한 차이는 로그 저장소가
CloudWatch Logs가 아니라 S3(Athena/Glue 카탈로그 경유)라는 위치뿐이다.

`web/lib/dns-logs.ts`, `web/lib/anfw-logs.ts`, and `web/lib/sg-analysis.ts` already run this async
query shape (CloudWatch Logs Insights `StartQueryCommand` → poll → `GetQueryResultsCommand`, +
`StopQueryCommand` on deadline) live, without any ADR-005/007 debate. **`sg-analysis.ts`
(`web/lib/sg-analysis.ts:572-585`) is the strongest precedent** — it queries the exact same data
(VPC Flow Logs) for the exact same purpose (SG rule matching) this feature extends. Athena's
`StartQueryExecution` → poll → `GetQueryResults` (+ `StopQueryExecution`) is structurally the same
pattern; the only difference is that the log store is S3 (via the Athena/Glue catalog) rather than
CloudWatch Logs.

### 3. 이 분석은 맥락이며, owner-override 등록을 대체하지 않는다

Athena 워크그룹이 쿼리 결과를 S3에 쓰는 것은 서비스 설계 자체이며(고객이 콘솔에서 직접 쿼리해도
동일하게 발생), 그 결과 위치는 고객이 사전 설정한 워크그룹 설정이다 — AWSops는 그 버킷이나 워크그룹을
생성·수정·삭제하지 않는다. AWSops가 쓰는 것은 이미 존재하는 고객 소유 위치에 남기는 임시 결과
객체이며, SG 규칙이나 EC2 인스턴스 같은 식별 가능한 인프라 리소스의 상태를 바꾸는 것과는 성격이 다르다.

**그러나 이 분석은 owner 승인의 대체물이 아니라, owner가 그 승인을 내리는 데 참고하는 맥락일
뿐이다.** §4가 설명하는 role(`AWSopsSgRuleAthenaRole`)은 이 저장소 최초의 write-capable
cross-account 신뢰 관계다. ADR-005 §Decision 3은 경계가 모호할 수 있는 신규 사례를 self-argument로
"동결 밖"이라 결론 내리는 것을 금지한다 — 그래서 이 ADR은 위 분석을 근거로 "ADR-005가 적용되지
않는다"고 결론 내리지 않는다. 대신 §Decision에서, ADR-015가 확립한 형식 그대로 **명시적이고 좁고
날짜박힌 owner-override 예외**를 등록한다.

An Athena workgroup writing query results to S3 is the query service's own design — the same thing
happens if a customer runs the same query from the console — and that result location is a
customer-pre-configured workgroup setting; AWSops never creates, modifies, or deletes that bucket or
workgroup. What AWSops writes is an ephemeral result object into an already-existing,
customer-owned location, which differs in character from changing the state of an identifiable
infrastructure resource (a security group, an EC2 instance).

**This analysis is context, not a substitute for owner approval.** The role §4 describes
(`AWSopsSgRuleAthenaRole`) is this repository's first write-capable cross-account trust
relationship. ADR-005 §Decision 3 prohibits resolving a boundary-ambiguous new case by self-argument
into "outside the freeze" — so this ADR does not use the analysis above to conclude ADR-005 doesn't
apply. Instead, §Decision below registers an explicit, narrow, dated owner-override exception, in
the exact form ADR-015 already established.

### 3b. `athena:StartQueryExecution`의 read-only 취급은 세 통제에서 도출된다

AWS 자체 서비스 권한 참조는 `athena:StartQueryExecution`을 **Write** 레벨 액션으로 분류한다 — 같은
동사로 `CREATE TABLE AS SELECT`·`INSERT INTO`·`DROP TABLE` 같은 DDL/DML도 실행된다. Athena의
read-only 취급은 동사 자체가 아니라 **세 통제의 조합**에서만 성립한다:

1. **제출 SQL이 SELECT-only로 제한** — 워커는 검증된 스키마 위에서 자체 생성한 SELECT만 실행하며
   사용자 제공 SQL을 절대 실행하지 않는다(spec "Flow Log source configuration").
2. **mutating Glue 동사가 IAM에서 배제** — SQL 통제가 뚫려도 IAM이 DDL을 차단한다.
3. **S3 write가 워크그룹의 사전 설정된 결과 prefix로 스코프** — 이 통제가 없으면 CTAS/INSERT 결과가
   임의 위치에 남을 수 있다.

세 통제가 함께 있어야만 `StartQueryExecution`이 실질적으로 read-only가 된다. 향후 리뷰어는 이 셋 중
하나를 건드리는 변경을 이 ADR 근거로 통과시켜서는 안 된다.

AWS's own service authorization reference classifies `athena:StartQueryExecution` as a
**Write**-level action — the identical verb also executes DDL/DML. Athena's read-only treatment is
**derived from three controls together**: (1) submitted SQL is constrained to SELECT-only
(validation-generated, never user-supplied), (2) mutating Glue verbs are excluded from IAM, (3) S3
write is scoped to the workgroup's pre-configured result prefix. All three must hold together; a
future reviewer must not approve a change to any one of them on this ADR's authority alone.

### 4. Cross-account access는 두 개의 별개 role이다

두 개의 서로 다른 cross-account grant가 있으며 섞이지 않는다:

1. **일일 rule 인벤토리 (`ec2:DescribeSecurityGroupRules`/`DescribeNetworkInterfaces`/`DescribeFlowLogs`)** —
   이미 web task role(`workload.tf:172-186`), Steampipe task role(`steampipe.tf:145-154`), agent
   Lambda execution role(`ai.tf:743-748`, `ai.tf:382-386`)이 쓰는 `arn:aws:iam::*:role/AWSopsReadOnlyRole`
   `sts:AssumeRole`를 재사용한다 — 이미 검증된 패턴의 새 호출자일 뿐이며 예외가 필요 없다.
   **온보딩 전제조건:** 대상 계정의 온보딩 템플릿(`infra/cfn/awsops-target-account-role.yaml`)의
   현재 신뢰 정책은 호스트 web task role ARN 하나로만 principal을 고정한다 — 이 role을 워커에도
   확장하려면 그 신뢰 정책에 워커 principal(host 계정의 dedicated task role 또는 broker Lambda, 아래
   역할 B와 동일한 identity를 재사용해도 됨)을 추가하는 온보딩 템플릿 업데이트가 필요하다. **role
   자체는 새롭지 않지만, 이 워커 principal을 위한 신뢰 정책 변경은 새로 필요하다** — 구현 PR이
   명시적으로 다뤄야 한다.
2. **일일 Athena 활동 파이프라인** — 대상 계정의 완전히 새로운 격리된 role
   (`AWSopsSgRuleAthenaRole`)을 assume한다. `AWSopsReadOnlyRole`은 건드리지 않는다 — 그 이름 자체가
   read-only 불변식이므로 어떤 첨부 방식으로도 write-capable 동사를 얹지 않는다. **호스트 계정이
   대상일 때(자기 계정 스캔)**: 워커는 self-assume하지 않는다 — 대신 호스트의 전용 task role/task
   definition 또는 broker Lambda가 §Decision 아래 정확히 동일한 허용/금지 목록을 직접(assume 없이)
   부여받는다. 이는 별도의, 더 넓은 예외가 아니다 — 같은 owner-override 예외가 다루는 동일한 3개
   메커니즘의 host-account 인스턴스일 뿐이다. 이 role(대상 계정 버전)은 공유 Fargate worker task
   role이 assume해서는 안 되며, 전용 task role/task definition 또는 broker Lambda로 assume 주체를
   격리한다(spec §IAM — 구현 시 둘 중 하나를 확정).

Two distinct cross-account grants exist, and they must not be conflated:

1. **Daily rule inventory** (`ec2:DescribeSecurityGroupRules`/`DescribeNetworkInterfaces`/`DescribeFlowLogs`) —
   reuses `sts:AssumeRole` on `arn:aws:iam::*:role/AWSopsReadOnlyRole` exactly as the web task role
   (`workload.tf:172-186`), the Steampipe task role (`steampipe.tf:145-154`), and the agent Lambda
   execution role (`ai.tf:743-748`, `ai.tf:382-386`) already do — a new caller of an already-vetted
   pattern, needing no exception. **Onboarding precondition:** the target-account onboarding
   template (`infra/cfn/awsops-target-account-role.yaml`) currently pins its trust policy's
   principal to the host web task role ARN only — extending this role to the worker requires an
   onboarding-template update adding the worker's principal (the host's dedicated task role or
   broker Lambda, which may reuse Role B's identity below). The role itself isn't new, but this
   trust-policy change is, and the implementing PR must address it explicitly.
2. **Daily Athena activity pipeline** — assumes a wholly new, isolated role in the target account
   (`AWSopsSgRuleAthenaRole`). `AWSopsReadOnlyRole` is untouched — its name is itself the read-only
   invariant, so it never carries a write-capable verb under any attachment method. **When the
   target is the host account itself** (self-account scanning): the worker does not self-assume —
   instead, the host's dedicated task role/task definition or broker Lambda is granted exactly the
   same Permitted/Excluded list below directly (no assume-role hop). This is not a separate, broader
   exception — it is the host-account instance of the same owner-override exception covering the
   same three mechanisms. This role (the target-account version) must not be assumable by the shared
   Fargate worker task role; a dedicated task role/task definition or a broker Lambda isolates the
   assuming principal (see spec §IAM — the choice between the two is confirmed at implementation
   time).

## Decision / 결정

**역할 A(rule 인벤토리)는 기존 read-only 불변식(BASELINE §1) 내부에 있으며 예외가 필요 없다 — 단,
§4의 온보딩 신뢰 정책 전제조건은 구현 PR에서 충족해야 한다.**

**역할 B(Athena/S3 활동 파이프라인, 대상 계정에서는 `AWSopsSgRuleAthenaRole`, 호스트 계정에서는 호스트
자체 principal에 직접 부여)는 ADR-005 동결에 대한 명시적·좁고·날짜박힌 owner-override 예외로
등록한다(ADR-015 패턴). 이 예외는 정확히 세 가지 메커니즘을 포괄하며, 그 이상으로 해석되지 않는다:**

1. **`s3:PutObject`/`AbortMultipartUpload`** — 워크그룹의 전용·격리된 결과 prefix에만 한정.
2. **`athena:StopQueryExecution`** — IAM으로는 "이 role이 시작한 쿼리만" 제한할 수 없는 동사이므로,
   워크그룹을 이 기능 전용으로 격리하는 것을 **하드 검증 전제조건**으로 삼아 그 위험을 억제한다(아래
   spec 참조 — 검증되지 않으면 소스 자체를 거부).
3. **`kms:Decrypt`(소스)/`kms:Decrypt`+`kms:GenerateDataKey`(결과 prefix)** — 소스가 SSE-KMS를 쓸 때만,
   그 소스에 등록된 특정 CMK ARN에만 한정.

**세 메커니즘 모두 §3b의 세 통제가 유지되는 동안만, 그리고 아래 Permitted 목록이 정확히 규정하는
스코프 안에서만 유효하다.**

**Role A (rule inventory) sits inside the existing read-only invariant (BASELINE §1) and needs no
exception — but §4's onboarding trust-policy precondition must be satisfied by the implementing PR.**

**Role B (the Athena/S3 activity pipeline — `AWSopsSgRuleAthenaRole` in target accounts, or granted
directly to the host's own principal in the host account) is registered as an explicit, narrow,
dated owner-override exception to the ADR-005 freeze (the ADR-015 pattern). This exception covers
exactly three mechanisms and is not read more broadly than this:**

1. **`s3:PutObject`/`AbortMultipartUpload`** — scoped only to the workgroup's dedicated, isolated
   result prefix.
2. **`athena:StopQueryExecution`** — IAM cannot restrict this verb to only the queries this role
   itself started, so the exception is bounded instead by a **hard validation precondition**: the
   configured workgroup must be exclusive to this feature (see spec below) — a source that can't be
   verified as exclusive is rejected outright.
3. **`kms:Decrypt` (source) / `kms:Decrypt`+`kms:GenerateDataKey` (result prefix)** — only when a
   source configures SSE-KMS, scoped to that source's specific registered CMK ARN(s).

**All three mechanisms are valid only while §3b's three controls hold, and only within the exact
scope the Permitted list below states.**

허용되는 것 — **역할 A: 재사용되는 `AWSopsReadOnlyRole`** (일일 rule 인벤토리) / Permitted — **Role A**
(daily rule inventory):
- `sts:AssumeRole` → `arn:aws:iam::*:role/AWSopsReadOnlyRole` (기존 패턴, worker principal로 확장 —
  대상 계정 온보딩 템플릿의 신뢰 정책 업데이트 필요, §4 참조)
- `ec2:DescribeSecurityGroupRules`, `ec2:DescribeNetworkInterfaces`, `ec2:DescribeFlowLogs`

- `sts:AssumeRole` → `arn:aws:iam::*:role/AWSopsReadOnlyRole` (existing pattern, extended to the
  worker principal — requires a target-account onboarding trust-policy update, see §4)
- `ec2:DescribeSecurityGroupRules`, `ec2:DescribeNetworkInterfaces`, `ec2:DescribeFlowLogs`

허용되는 것 — **역할 B** (일일 Athena 활동 파이프라인, `AWSopsReadOnlyRole`과 전혀 별개) / Permitted —
**Role B** (daily Athena activity pipeline, wholly separate from `AWSopsReadOnlyRole`):

- `sts:AssumeRole` → 대상 계정의 `AWSopsSgRuleAthenaRole` (호스트 계정이 대상일 때는 assume 없이
  호스트 자신의 전용 task role/broker Lambda에 동일 목록을 직접 부여). Assume 주체는 전용 task
  role/task definition 또는 broker Lambda로 한정 — 공유 워커 task role은 절대 assume 불가(§4).
  **신뢰 정책(대상 계정 role):** `ExternalId` 조건 **+ ** 호스트의 Athena-worker identity로 제한된
  명시적 principal ARN을 **모두** 요구 — wildcard principal 금지, `ExternalId` 누락 금지. (이 저장소의
  기존 read-only cross-account role은 1st-party 경로에서 `ExternalId`가 없을 수 있다 — ADR-011의
  완화. 이 write-capable role에 대한 요구는 그 완화의 **명시적 예외**이며, 상속이 아니다.)
- `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`,
  `athena:StopQueryExecution`, `athena:GetWorkGroup` — **구성된 워크그룹의 ARN에 한정**(`Resource:
  "*"` 아님). §3b의 세 통제가 유지되는 조건 하에서만 read-only로 간주. `StopQueryExecution`은 위
  §Decision 2가 명시한 대로 워크그룹 전용성이라는 하드 전제조건으로 뒷받침된다.
- `glue:GetDatabase`, `glue:GetTable`, `glue:GetPartitions` — **구성된 카탈로그/데이터베이스/테이블
  ARN에 한정**(`Resource: "*"` 아님)
- `s3:GetBucketLocation` — 소스 버킷과 결과 버킷 양쪽 모두(서로 다른 버킷/계정일 수 있으므로 둘 다
  필요)
- **소스 위치(read-only):** `s3:GetObject`, `s3:ListBucket`(둘 다 `s3:prefix` 조건으로 소스의 등록된
  Flow Log table 위치에 스코프) — SQL 쿼리가 실제로 읽는 데이터
- **결과 prefix(read+write, 둘 다 필요):** `s3:GetObject`, `s3:ListBucket`, `s3:PutObject`,
  `s3:AbortMultipartUpload`(모두 `s3:prefix` 조건으로 워크그룹의 전용·격리된 결과 prefix에 스코프).
  write는 Athena 실행 자체의 필수 동작(§3). read도 함께 필요한 이유: Athena 자신이 `GetQueryResults`
  처리와 (활성화 시) 쿼리 결과 재사용 판단을 위해 자기가 쓴 결과를 다시 읽는다 — write만 부여하면
  실제로 동작하지 않는다.
- **KMS(조건부, 소스가 SSE-KMS를 쓸 때만):** `kms:Decrypt`(소스 CMK ARN), `kms:Decrypt`+
  `kms:GenerateDataKey`(결과 prefix CMK ARN) — 둘 다 그 소스에 등록된 **특정** key ARN에만 한정, 계정
  전체 KMS 접근 아님. SSE-KMS를 쓰지 않는 소스에는 이 grant 자체가 존재하지 않는다.

- `sts:AssumeRole` → the target account's `AWSopsSgRuleAthenaRole` (or, when the host account is the
  target, the same list granted directly to the host's own dedicated task role/broker Lambda without
  an assume-role hop). The assuming principal is restricted to a dedicated task role/task definition
  or a broker Lambda — the shared worker task role may never assume it (§4). **Trust policy (target-
  account role):** requires BOTH an `ExternalId` condition AND an explicit principal ARN restriction
  to the host's Athena-worker identity — no wildcard principal, no missing `ExternalId`. (This
  repo's existing read-only cross-account role can lack `ExternalId` on its 1st-party path, per
  ADR-011's relaxation — the requirement here is an explicit override of that relaxation for this
  write-capable role, not an inheritance from it.)
- `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`,
  `athena:StopQueryExecution`, `athena:GetWorkGroup` — **scoped to the configured workgroup's ARN**
  (never `Resource: "*"`). Treated as read-only only while §3b's three controls hold.
  `StopQueryExecution` is backed by the workgroup-exclusivity hard precondition named in §Decision 2.
- `glue:GetDatabase`, `glue:GetTable`, `glue:GetPartitions` — **scoped to the configured
  catalog/database/table ARNs** (never `Resource: "*"`)
- `s3:GetBucketLocation` — on both the source bucket and the result bucket (they may be different
  buckets/accounts, and Athena needs this on both)
- **Source location (read-only):** `s3:GetObject`, `s3:ListBucket` (both scoped via an `s3:prefix`
  condition to the source's registered Flow Log table location) — the data the SQL query actually
  reads.
- **Result prefix (read AND write, both required):** `s3:GetObject`, `s3:ListBucket`,
  `s3:PutObject`, `s3:AbortMultipartUpload` (all scoped via an `s3:prefix` condition to the
  workgroup's dedicated, isolated result prefix). Write is a required mechanic of running an Athena
  query at all (§3). Read is required too — Athena itself reads back the objects it wrote to serve
  `GetQueryResults` and (when enabled) evaluate query result reuse; write-only would not actually
  work.
- **KMS (conditional — only when a source configures SSE-KMS):** `kms:Decrypt` (the source's CMK
  ARN), `kms:Decrypt` + `kms:GenerateDataKey` (the result prefix's CMK ARN) — both scoped to the
  **specific** key ARN(s) registered for that source, never account-wide KMS access. Sources that
  don't use SSE-KMS carry no KMS grant at all.

명시적으로 금지되는 것 / Explicitly excluded:
- `athena:CreateWorkGroup`/`UpdateWorkGroup`/`DeleteWorkGroup`
- `glue:CreateTable`/`CreateDatabase`/`DeleteTable`/`DeleteDatabase`/`UpdateTable`/
  `BatchCreatePartition`/`BatchDeletePartition` 및 그 밖의 모든 Glue mutating 동사(허용 목록은
  `GetDatabase`/`GetTable`/`GetPartitions` 셋뿐 — allowlist-only, "등" 같은 개방형 표현 금지)
- 어떤 형태로도 사용자/운영자가 제출한 SQL을 그대로 실행하는 경로 — 제출 쿼리는 항상 검증된 스키마
  위에서 워커가 자체 생성한 SELECT여야 한다(§3b 통제 1)
- 워크그룹 결과 prefix **바깥으로의** `s3:PutObject`/`s3:DeleteObject`, 그리고 어떤 prefix에서도
  `s3:DeleteObject`
- 소스 Flow Log table 위치와 워크그룹 결과 prefix, 이 두 곳 **바깥으로의** `s3:GetObject`/`s3:ListBucket`
- `s3:PutBucketPolicy`/`s3:PutBucketAcl`/`s3:PutObjectAcl`/`s3:DeleteBucketPolicy` 및 그 밖의 모든
  bucket-policy·ACL write 동사
- `ec2:RevokeSecurityGroupIngress`/`Egress`, `ec2:AuthorizeSecurityGroupIngress`/`Egress` 및 그 어떤
  mutating EC2 동사
- `iam:CreateRole`/`PassRole`(역할 A·B 어느 쪽에 대해서도 — 둘 다 기존 신뢰 관계 assume만)
- `AWSopsSgRuleAthenaRole` 신뢰 정책에 wildcard principal 또는 `ExternalId` 누락
- 공유 Fargate worker task role에 `AWSopsSgRuleAthenaRole`로의 `sts:AssumeRole` 직접 부여
- 계정 전체 또는 리소스 미지정(`Resource: "*"`) KMS 권한 — KMS grant는 항상 소스별 특정 key ARN에만

- `athena:CreateWorkGroup`/`UpdateWorkGroup`/`DeleteWorkGroup`
- `glue:CreateTable`/`CreateDatabase`/`DeleteTable`/`DeleteDatabase`/`UpdateTable`/
  `BatchCreatePartition`/`BatchDeletePartition`, and any other Glue mutating verb (the allowlist is
  exactly `GetDatabase`/`GetTable`/`GetPartitions` — allowlist-only, no open-ended "etc.")
- any path that executes user/operator-submitted SQL verbatim — every submitted query must be the
  worker's own validation-generated SELECT over the validated schema (§3b control 1)
- `s3:PutObject`/`s3:DeleteObject` outside the workgroup's result prefix, and `s3:DeleteObject` in
  any prefix
- `s3:GetObject`/`s3:ListBucket` outside both the source Flow Log table location and the workgroup
  result prefix
- `s3:PutBucketPolicy`/`s3:PutBucketAcl`/`s3:PutObjectAcl`/`s3:DeleteBucketPolicy` and any other
  bucket-policy/ACL write verb
- `ec2:RevokeSecurityGroupIngress`/`Egress`, `ec2:AuthorizeSecurityGroupIngress`/`Egress`, and any
  other mutating EC2 verb
- `iam:CreateRole`/`PassRole` for either role — both only assume an existing trust relationship
- a wildcard principal or missing `ExternalId` on `AWSopsSgRuleAthenaRole`'s trust policy
- granting the shared Fargate worker task role a direct `sts:AssumeRole` on `AWSopsSgRuleAthenaRole`
- account-wide or unscoped (`Resource: "*"`) KMS permissions — KMS grants are always scoped to a
  specific per-source key ARN

**하드 검증 전제조건 (IAM만으로는 강제할 수 없어 소스 검증 시점에 강제됨):**
- 구성된 워크그룹은 이 기능 전용이어야 한다(다른 principal과 공유되지 않음) — `athena:StopQueryExecution`
  예외의 blast radius를 이것으로 한정한다. 전용성을 증명할 수 없는 소스는 거부.
- 워크그룹 결과 위치는 전용·비-루트 prefix여야 한다(`s3://bucket/` 같은 루트 금지).
- 소스 Flow Log table 위치와 결과 prefix는 겹치지 않아야 한다.
- 워크그룹은 `EnforceWorkGroupConfiguration` 활성 + `BytesScannedCutoffPerQuery` ≤
  `sg_rule_activity_max_query_bytes`(기본 100 GiB, 신규 Terraform 변수)여야 한다.

**Hard validation preconditions (cannot be enforced by IAM alone, so enforced at source
validation):**
- The configured workgroup must be exclusive to this feature (not shared with any other
  principal) — this is what bounds the `athena:StopQueryExecution` exception's blast radius. A
  source whose workgroup exclusivity cannot be proven is rejected.
- The workgroup's result location must be a dedicated, non-root prefix (never a bucket root like
  `s3://bucket/`).
- The source Flow Log table location and the result prefix must not overlap.
- The workgroup must have `EnforceWorkGroupConfiguration` enabled with
  `BytesScannedCutoffPerQuery` ≤ `sg_rule_activity_max_query_bytes` (default 100 GiB, a new
  Terraform variable).

이에 따라 `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`의 Feature Gate /
IAM 절은 이 ADR과 합의된 상태다: `sg_rule_activity_enabled`는 ADR-007 티어가 아니며, 일반 GATED도
아니다 — 이 ADR이 등록하는 owner-override 예외가 적용되는 조건부 GATED 항목이다
(`docs/decisions/BASELINE.md` §2, "GATED(owner-override 예외)" — ADR-015 행과 같은 표기, default
OFF, `workers_enabled` 선행 요구). **이 ADR은 `docs/superpowers/specs/2026-08-13-network-path-check-design.md`나
`network_path_check_enabled`를 다루지 않는다** — 그 spec은 이 ADR과 무관하게 자체 남은 조건(BASELINE
§2 행 + adapter-safety 재검토 1회)만으로 Approved 전환되었으며, BASELINE §2의 해당 행은 근거 ADR을
"—"로 표기한다.

Accordingly, the Feature Gate / IAM section of
`docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md` is aligned with this ADR:
`sg_rule_activity_enabled` is neither ADR-007-tier nor an ordinary GATED entry — it is a conditional
GATED entry covered by this ADR's owner-override exception (`docs/decisions/BASELINE.md` §2, labeled
"GATED(owner-override 예외)" the same way as the ADR-015 row, default OFF, requires
`workers_enabled`). **This ADR does not cover
`docs/superpowers/specs/2026-08-13-network-path-check-design.md` or `network_path_check_enabled` at
all** — that spec moved to Approved on its own remaining conditions (a BASELINE §2 row + one
adapter-safety review pass), independent of this ADR, and its BASELINE §2 row records its 근거 ADR
as "—".

## Consequences / 결과

### Positive / 긍정
- SG Rules 기능이 존재하지 않는 governance 절차(ADR-007 확장) 없이, ADR-015가 이미 확립한 절차(owner-override
  예외)를 그대로 재사용해 진행 가능해진다.
- IAM 표면이 역할 A(read-only 동사만, 리소스 스코프)와 역할 B(read/query + 정확히 세 가지 명명된
  메커니즘, 각각 리소스·prefix·key ARN으로 스코프)로 명확히 분리되어, 향후 리뷰가 mutating 동사
  유입이나 스코프 확장을 즉시 걸러낼 수 있는 bright line을 가진다.

- Enables the SG Rules feature to proceed by reusing the procedure ADR-015 already established
  (owner-override exception), without inventing a new governance track.
- The IAM surface is cleanly split between Role A (read-only verbs, resource-scoped) and Role B
  (read/query plus exactly three named mechanisms, each scoped to a resource/prefix/key ARN) —
  future reviewers have a bright line against scope creep or a new mutating verb.

### Negative / Trade-offs
- Athena 비용(스캔 바이트당 과금)은 read-only이지만 예산에 영향을 준다 — 이 ADR이 신설한
  `sg_rule_activity_max_query_bytes`(기본 100 GiB) + 워크그룹 `EnforceWorkGroupConfiguration`/
  `BytesScannedCutoffPerQuery` 하드 전제조건으로 통제.
- 역할 B는 이 저장소 최초의 write-capable cross-account 신뢰 관계다 — read-only로 명명된 기존
  sibling role과 달리, 이 role이 손상되면 스코프된 write 능력(결과 prefix)과 다른 principal의
  실행 중인 쿼리를 취소할 능력(`StopQueryExecution`, 워크그룹 전용성으로만 제한됨)이 노출된다. 이는
  "read-only sibling과 같은 수준의 잔여 리스크"가 아니라 다른, 더 큰 범주의 신뢰다 — 그래서
  owner-override 예외로 등록한다.
- 역할 A의 온보딩 신뢰 정책 업데이트(§4)는 구현 PR에서 대상 계정 템플릿을 건드려야 하는 실제
  작업이다 — "이미 존재하는 role의 새 호출자일 뿐"이라는 서술이 신뢰 정책 자체는 변경 불필요를
  뜻하지는 않는다.

- Athena cost (billed per byte scanned) is read-only but has budget impact — controlled by this
  ADR's new `sg_rule_activity_max_query_bytes` (default 100 GiB) and the workgroup
  `EnforceWorkGroupConfiguration`/`BytesScannedCutoffPerQuery` hard precondition.
- Role B is this repository's first write-capable cross-account trust relationship — unlike its
  read-only-named sibling, a compromise of this role exposes scoped write capability (the result
  prefix) and the ability to cancel other principals' in-flight queries (`StopQueryExecution`,
  bounded only by workgroup exclusivity). This is not "the same residual risk every existing caller
  already carries"; it is a genuinely larger category of trust, which is why it is registered as an
  owner-override exception.
- Role A's onboarding trust-policy update (§4) is real implementation work touching the
  target-account template — "just a new caller of an existing role" does not mean the trust policy
  itself needs no change.

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Security**: 역할 A는 read-only 동사만, 리소스 스코프. 역할 B는 read/query 동사 + 정확히 세
  메커니즘(결과-prefix write, 워크그룹-전용성으로 제한된 StopQueryExecution, 소스별 특정 CMK로
  스코프된 조건부 KMS)만 화이트리스트 — mutating 동사·계정 전역 리소스·wildcard 신뢰 정책 명시
  배제. assume 주체는 전용 task role/broker Lambda로 격리(공유 워커 task role 배제).
- **Reliability**: CloudWatch Logs Insights와 동일한 폴링+타임아웃+`StopQueryExecution` 취소 패턴
  재사용.
- **Operational Excellence**: ADR-015 절차(새 ADR + 멀티-AI 패널 + 날짜박힌 owner-override) 완전
  충족. BASELINE §2에 `sg_rule_activity_enabled`를 GATED(owner-override 예외)로 등록(같은 PR) —
  플래그 자체는 미구현이므로 승인됨·미구현으로 명시.
- **Cost**: 기본 OFF; 켜져도 `sg_rule_activity_max_query_bytes` 스캔 바이트 상한 + 워크그룹
  `EnforceWorkGroupConfiguration`/`BytesScannedCutoffPerQuery` 검증으로 통제.
- **Performance/Sustainability**: 일 1회 배치 쿼리(소스당), 상시 자원 추가 없음(워커 role IAM
  정책 외).
