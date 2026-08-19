# ADR-019: SG Rules Athena 활동 파이프라인 — ADR-005에 대한 좁은 owner-override 예외 / SG Rules Athena Activity Pipeline — a Narrow Owner-Override Exception to ADR-005

## Status / 상태

**Accepted (2026-08-19) — GATED(owner-override 예외), ADR-015 패턴, 멀티-AI 패널 리뷰 2라운드 완료.**

> **2026-08-19 재검토(3라운드 패널, PR #230 리뷰) — 프레이밍 정정.** 최초 초안과 2라운드 수정은 "ADR-005 완화도 ADR-007 티어도 필요 없다"고 서술했다. 3라운드 패널(codex-L3/L5, kiro-gpt-L3/L5가 CRITICAL/MAJOR로 수렴, kiro-opus-L3는 반대)은 이 서술이 ADR-005 §Decision 3("조용한 default 토글, 코드 주석 완화, 또는 'clarification' 식 사후 재서술로는 해제할 수 없다")이 금지하는 정확히 그 모양이라고 지적했다 — 이 ADR이 "이 저장소 최초의 write-capable cross-account 신뢰 관계"를 비준하면서도 그것이 예외가 아니라고 주장하는 것은 자기모순이다. **정정: 이 ADR은 ADR-005를 반박·대체하지 않는다 — 대신 ADR-015가 이미 확립한 패턴을 따라, ADR-005 동결에 대한 좁고·명시적이고·날짜가 박힌 owner-override 예외를 하나 더 등록한다.** 예외 대상은 정확히 하나의 메커니즘(Role B의 `s3:PutObject`/`AbortMultipartUpload`, §3b 세 통제 조건부)뿐이다. Role A(rule 인벤토리의 `AWSopsReadOnlyRole` 재사용)는 예외가 필요 없다 — 이미 비준된 read 전용 패턴의 새 호출자일 뿐이다.

- **Owner:** 오준석(Junseok Oh) — `/co-agent:consensus` 세션에서 이 ADR 초안 작성 및 패널 리뷰를 명시적으로 지시했고, 매 라운드 패널이 발견한 수정 내용을 확인한 뒤 Accepted 전환(그리고 이번 owner-override 예외로의 재프레이밍)을 명시적으로 승인했다("계속진행"). SG-Rules spec이 요구한 "새 ADR + 멀티-AI 패널 + 날짜박힌 owner-override"(ADR-015 절차) 전부를 이 방식으로 충족한다.
- **패널 기록 (3라운드):** 1~2라운드 — codex(openai.gpt-5.5) + kiro-cli(claude-fable-5), IAM 스코프/read-only 속성 도출 관련 MAJOR 다수 해소(§3b 신설, S3 read/write 분리, 신뢰 정책·ACL 배제 추가). 3라운드 — PR #230의 5-lens 패널(codex/kiro-opus/kiro-gpt × L2~L5)이 이 ADR과 두 spec의 Approved 승격 자체를 리뷰: ADR-005 프레이밍 충돌(위에서 정정) 외에도 IAM 경계의 구현 불가능성(전용 결과 prefix·source/result 겹침 검사·`s3:prefix` 조건·workgroup ARN 스코프 미명시), 존재하지 않는 비용 통제 인용, BASELINE register의 라이브 컬럼 오용, spec §IAM과 이 ADR의 grant 목록 간 PR 내부 불일치, network-path spec의 `not_run` 어휘 모순을 MAJOR로 확인 — 모두 이 문서와 두 spec에서 해소(아래 각 섹션 참조).
- 이 ADR은 `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`가 "새 ADR을 통해서만 해소된다"고 명시한 ADR-005/ADR-007 분류 질문을 다룬다.

**Accepted (2026-08-19) — GATED(owner-override exception), ADR-015 pattern, 2 panel rounds complete.**

> **2026-08-19 re-review (round 3 panel, PR #230) — framing correction.** The original draft and
> round-2 fix stated "neither an ADR-005 relaxation nor an ADR-007-tier classification is needed."
> Round 3's panel (codex-L3/L5 and kiro-gpt-L3/L5 converging on CRITICAL/MAJOR; kiro-opus-L3
> dissenting) flagged that framing as exactly the shape ADR-005 §Decision 3 prohibits ("no silent
> toggle/comment-softening/'clarification'-style post-hoc restatement") — this ADR ratifies "the
> repo's first write-capable cross-account trust relationship" while simultaneously claiming that
> isn't an exception, which is self-contradictory. **Correction: this ADR does not rebut or
> supersede ADR-005 — it registers one more narrow, explicit, dated owner-override exception,
> following the pattern ADR-015 already established.** The exception covers exactly one mechanism
> (Role B's `s3:PutObject`/`AbortMultipartUpload`, conditioned on §3b's three controls). Role A (the
> reused `AWSopsReadOnlyRole` for rule inventory) needs no exception — it is only a new caller of an
> already-ratified read-only pattern.

- **Owner:** 오준석(Junseok Oh) — explicitly directed drafting this ADR and running the panel review
  inside a `/co-agent:consensus` session, and explicitly approved each round's Accepted transition
  (and this owner-override reframing) after reviewing that round's findings ("계속진행"). This
  satisfies the full "new ADR + multi-AI panel + dated owner-override" instrument (the ADR-015
  procedure) the SG-Rules spec required.
- **Panel record (3 rounds):** Rounds 1-2 — codex (openai.gpt-5.5) + kiro-cli (claude-fable-5) —
  resolved several MAJORs on IAM scope and the derived read-only property (added §3b, split S3
  read/write, added trust-policy and ACL exclusions). Round 3 — PR #230's 5-lens panel
  (codex/kiro-opus/kiro-gpt × L2-L5) reviewed this ADR and both specs' Approved promotion itself:
  confirmed MAJOR on the ADR-005 framing conflict (corrected above), the IAM boundary's
  unimplementability as written (missing dedicated result-prefix requirement, source/result overlap
  check, `s3:prefix` condition, workgroup-ARN scoping), a cited cost control that exists in no
  document, BASELINE register misuse of the live-verified column, an intra-PR contradiction between
  this ADR's ratified grants and the SG spec's own §IAM list, and a `not_run` vocabulary
  contradiction in the network-path spec — all resolved in this document and the two specs (see the
  relevant section below for each).
- This ADR resolves the ADR-005/ADR-007 classification question that
  `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md` states can only be
  settled by a new ADR.

## Context / 컨텍스트

`docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`는 SG Rules 기능(일일 `DescribeSecurityGroupRules`/`DescribeNetworkInterfaces` 인벤토리 + Athena 기반 90일 트래픽 증거 파이프라인)이 두 가지 신규 능력을 필요로 한다고 밝힌다: (1) `athena:StartQueryExecution`/`StopQueryExecution` + 고객이 사전 설정한 워크그룹 결과 위치로의 S3 write(spec §IAM 설계상 대상 계정의 **신규 격리된** role, `AWSopsSgRuleAthenaRole`을 통해), (2) 현재 P2 워커 role(`worker_task`/`worker_lambda`)에는 전혀 없는 cross-account 접근(rule 인벤토리 부분은 기존 `AWSopsReadOnlyRole` 재사용). spec 작성자는 이를 "ADR-007-tier"(외부 DATA write)로 자체 분류했으나, 그 분류가 **본인의 추론일 뿐 비준된 결정이 아님**을 spec 스스로 인정하며, ADR-015 선례(새 ADR + 멀티-AI 패널 + 날짜박힌 owner-override)를 요구했다.

The SG Rules feature's daily rule-inventory scan plus its Athena-based 90-day traffic-evidence
pipeline needs two capabilities the codebase does not have today: (1) `athena:StartQueryExecution`/
`StopQueryExecution` plus an S3 write into a customer-pre-configured workgroup result location — per
the spec's own §IAM design, through a **new, isolated** role in the target account
(`AWSopsSgRuleAthenaRole`), and (2) cross-account access the P2 worker roles (`worker_task`/
`worker_lambda`) currently hold none of (the rule-inventory half reuses the existing
`AWSopsReadOnlyRole`). The spec's own author self-classified this as "ADR-007-tier" (external DATA
write) but explicitly flagged that classification as unratified reasoning, not a decision, and
required the ADR-015-style instrument (new ADR + multi-AI panel + dated owner-override) to settle it.

이 ADR은 그 분류 질문 자체를 다시 검토한다. **결론(3라운드 정정): 두 능력 모두 ADR-007의 "외부 DATA" 범주에 속하지 않는다. 그러나 하나는 서로 다르게 처리된다 — 역할 A(rule 인벤토리, `AWSopsReadOnlyRole` 재사용)는 이미 라이브인 기존 패턴의 새 호출자일 뿐이라 예외가 필요 없다. 역할 B(Athena/S3 write, `AWSopsSgRuleAthenaRole`)는 이 저장소 최초의 write-capable cross-account 신뢰 관계이므로, ADR-005에 대한 좁고 명시적인 owner-override 예외로 등록한다(ADR-015 패턴) — "완화가 필요 없다"고 주장하지 않는다.**

This ADR re-examines the classification question itself. **Conclusion (round-3 correction): neither
capability belongs to ADR-007's "external DATA" category. But the two are treated differently —
Role A (rule inventory, reusing `AWSopsReadOnlyRole`) is only a new caller of an already-live
pattern and needs no exception. Role B (Athena/S3 write, `AWSopsSgRuleAthenaRole`) is this
repository's first write-capable cross-account trust relationship, so it is registered as a narrow,
explicit owner-override exception to ADR-005 (the ADR-015 pattern) — not claimed to need no
relaxation at all.**

### 1. Athena/Glue 는 "외부 DATA" 가 아니라 AWS-네이티브 데이터 서비스다 / Athena/Glue are AWS-native, not "external DATA"

ADR-007의 "외부 DATA"는 AWS 바깥의 제3자 SaaS(Slack, Notion, Jira, 외부 관측성 플랫폼)를 가리킨다 — AWS 계정 경계를 넘어 신뢰를 확장하는 것이 그 조항의 위험 모델이다. Athena·Glue·S3는 고객이 이미 온보딩한 **같은 AWS 계정 안의** AWS 네이티브 서비스다. 이들에 대한 read-query 호출은 `DescribeSecurityGroupRules`나 `logs:StartQuery`(CloudWatch Logs Insights)와 동일한 신뢰 경계 안에 있다.

ADR-007's "external DATA" means third-party SaaS outside AWS (Slack, Notion, Jira, external
observability platforms) — its risk model is about extending trust across the AWS account boundary.
Athena, Glue, and S3 are AWS-native services **inside the same already-onboarded AWS account**.
Read-query calls against them sit inside the exact same trust boundary as `DescribeSecurityGroupRules`
or CloudWatch Logs Insights' `logs:StartQuery`.

### 2. 정확히 같은 형태의 패턴이 이미 라이브다 / The exact same shape of pattern is already live

`web/lib/dns-logs.ts`, `web/lib/anfw-logs.ts`, `web/lib/sg-analysis.ts`는 이미 CloudWatch Logs Insights의 `StartQueryCommand` → 폴링 → `GetQueryResultsCommand` (+ 데드라인 시 `StopQueryCommand`)를 사용해 로그 데이터를 비동기 조회한다 — 어떤 ADR-005/007 논쟁도 거치지 않고 라이브다. **`sg-analysis.ts`(`web/lib/sg-analysis.ts:572-585`)가 가장 강한 선례다** — 바로 이 기능이 다루는 동일한 데이터(VPC Flow Logs)를 동일한 목적(SG rule 매칭)으로 조회하는, 지금 이미 라이브인 코드다. (**정정, 2026-08-19 3라운드 패널:** 이전 초안은 `web/lib/nfm.ts`를 예로 들었으나, 실측 결과 `nfm.ts`는 `@aws-sdk/client-networkflowmonitor`(`StartQueryMonitorTopContributorsCommand` 계열)를 쓰지 Logs Insights가 아니다 — 오인용이었다.) Athena의 `StartQueryExecution` → 폴링 → `GetQueryResults` (+ `StopQueryExecution`)는 **구조적으로 동일한 패턴**이다: 비동기 조회를 시작하고, 결과를 가져오고, 필요시 취소한다. 유일한 차이는 로그 저장소가 CloudWatch Logs가 아니라 S3(Athena/Glue 카탈로그 경유)라는 것뿐이며, 이는 조회 대상 데이터의 위치이지 조회 행위의 성격을 바꾸지 않는다.

`web/lib/dns-logs.ts`, `web/lib/anfw-logs.ts`, and `web/lib/sg-analysis.ts` already run CloudWatch
Logs Insights' `StartQueryCommand` → poll → `GetQueryResultsCommand` (+ `StopQueryCommand` on
deadline) to query log data asynchronously — live today, without any ADR-005/007 debate.
**`sg-analysis.ts` (`web/lib/sg-analysis.ts:572-585`) is the strongest precedent** — it is live code
today, querying the exact same data (VPC Flow Logs) for the exact same purpose (SG rule matching)
this feature extends. (**Correction, 2026-08-19 round-3 panel:** an earlier draft cited
`web/lib/nfm.ts` here — verified against source, `nfm.ts` actually uses
`@aws-sdk/client-networkflowmonitor` (`StartQueryMonitorTopContributorsCommand` family), not Logs
Insights; that was a misattribution.) Athena's `StartQueryExecution` → poll → `GetQueryResults` (+
`StopQueryExecution`) is **structurally the same pattern**: start an async query, fetch results,
cancel if needed. The only difference is that the log store is S3 (via the Athena/Glue catalog)
instead of CloudWatch Logs — a difference in where the queried data lives, not in the nature of the
query action.

### 3. Athena 의 결과-S3-write는 조회 서비스 자체의 내부 메커니즘이다 / Athena's result S3 write is an intrinsic mechanic of the query service, not a resource mutation

Athena 워크그룹은 쿼리 결과를 S3에 쓰는 것이 서비스 설계 자체다 — 고객이 콘솔에서 직접 쿼리를 실행해도 동일하게 발생한다. 그 결과 위치는 **고객이 사전에 설정한 워크그룹 설정**이며, AWSops는 그 버킷이나 워크그룹을 생성·수정·삭제하지 않는다(spec의 소스 검증 절차는 read-only 확인만 수행 — `GetWorkGroup`/`GetTable`/`GetDatabase`, mutating 동사 없음). AWSops가 쓰는 것은 그 서비스가 이미 존재하는 고객 소유 위치에 남기는 임시 결과 객체이며, 이는 SG 규칙이나 EC2 인스턴스 같은 **식별 가능한 인프라 리소스의 상태**를 바꾸는 것이 아니다. `logs:StartQuery`가 CloudWatch 내부에 쿼리 실행 레코드를 만드는 것과 동일한 층위다 — 아무도 그것을 "AWS 리소스 변경"으로 취급하지 않는다.

An Athena workgroup writing query results to S3 is the query service's own design — the same thing
happens if a customer runs the same query from the console. That result location is a
**customer-pre-configured workgroup setting**; AWSops never creates, modifies, or deletes that
bucket or workgroup (the spec's own source-validation procedure is read-only-only — `GetWorkGroup`/
`GetTable`/`GetDatabase`, no mutating verb). What AWSops writes is an ephemeral result object into a
pre-existing, customer-owned location the service already writes to regardless of caller — it does
not change the **state of any identifiable infrastructure resource** (a security group, an EC2
instance). This sits at the same layer as `logs:StartQuery` creating an internal query-execution
record inside CloudWatch — nobody treats that as "AWS resource mutation" either.

### 3b. `athena:StartQueryExecution`의 read-only 속성은 도출된 것이며 세 가지 통제에 의존한다 (2026-08-19 패널 리뷰로 추가) / `athena:StartQueryExecution`'s read-only property is DERIVED, resting on three controls (added 2026-08-19 panel review)

**패널 리뷰(codex, kiro-cli/claude-fable-5)가 정정을 요구한 지점.** AWS 자체 서비스 권한 참조는 `athena:StartQueryExecution`을 **Write** 레벨 액션으로 분류한다 — 같은 동사로 `CREATE TABLE AS SELECT`·`INSERT INTO`·`DROP TABLE` 같은 DDL/DML도 실행된다. `logs:StartQuery`(CloudWatch Logs Insights, Read 레벨— 쓰기 형태가 없는 쿼리 언어)와 달리, Athena의 read-only 속성은 동사 자체가 아니라 **세 가지 통제의 조합**에서만 나온다:

1. **제출되는 SQL 텍스트가 SELECT-only로 제한**된다 — spec이 이미 규정: "Schema mapping and the discovered partition strategy are generated by validation... users cannot provide arbitrary column expressions or SQL." 워커는 검증된 스키마 위에서 자체 생성한 SELECT만 실행하며, 사용자 제공 SQL을 절대 실행하지 않는다.
2. **mutating Glue 동사가 IAM에서 배제**된다(`CreateTable`/`DeleteTable`/`CreateDatabase`/`DeleteDatabase` 등 — 아래 Decision 참조) — SQL 텍스트 통제가 뚫려도 IAM이 DDL을 차단한다.
3. **S3 write가 고객 워크그룹의 사전 설정된 결과 prefix로 스코프**된다(아래 §Decision — 이 통제가 없으면 CTAS/INSERT 결과가 임의 위치에 남을 수 있다).

이 세 통제가 함께 있어야만 `StartQueryExecution`이 실질적으로 read-only가 된다 — 하나라도 조용히 완화되면(예: SQL 생성 로직 변경, IAM에서 Glue 동사 추가, S3 prefix 스코프 제거) 아무 "동사 변경" 신호 없이 mutation 경로로 전환될 수 있다. 이 의존성을 명시하는 것이 바로 이 ADR의 목적이다 — 향후 리뷰어가 이 세 항목 중 하나를 건드리는 변경을 이 ADR 근거로 통과시키지 못하게 한다.

**Panel review correction point.** AWS's own service authorization reference classifies
`athena:StartQueryExecution` as a **Write**-level action — the identical verb also executes
DDL/DML (`CREATE TABLE AS SELECT`, `INSERT INTO`, `DROP TABLE`). Unlike `logs:StartQuery`
(CloudWatch Logs Insights, Read-level — a query language with no write forms), Athena's read-only
property is not intrinsic to the verb; it is **derived from three controls together**:

1. **The submitted SQL text is constrained to SELECT-only** — the spec already requires this:
   "Schema mapping and the discovered partition strategy are generated by validation... users
   cannot provide arbitrary column expressions or SQL." The worker runs only its own
   validation-generated SELECT over the validated schema, never user-supplied SQL.
2. **Mutating Glue verbs are excluded from IAM** (`CreateTable`/`DeleteTable`/`CreateDatabase`/
   `DeleteDatabase`, etc. — see Decision below) — if the SQL-text control were ever bypassed, IAM
   still blocks the DDL.
3. **S3 write is scoped to the customer workgroup's pre-configured result prefix** (see Decision
   below) — without this, a CTAS/INSERT result could land anywhere.

All three controls must hold together for `StartQueryExecution` to be read-only in practice — any
one silently loosened (a change to the SQL-generation logic, a Glue verb added to IAM, the S3 prefix
scope removed) could flip this into a mutation path with no verb-level signal. Stating this
dependency explicitly is the point of this section: a future reviewer must not approve a change to
any one of these three controls on this ADR's authority alone.

### 4. Cross-account access는 두 개의 별개 role이다 — read-only 재사용 role과, 신규 격리된 write-capable role / Cross-account access is TWO separate roles — a reused read-only role, and a new, isolated write-capable role

> **2026-08-19 정정 (패널 리뷰 이후 재검토, SG-Rules spec 본문과의 불일치 발견).** 이 절의 초판은 SG Rules
> 기능이 필요로 하는 cross-account 접근을 `AWSopsReadOnlyRole` 확장 하나로만 서술했다. 그러나
> `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`의 IAM 절(§IAM and
> multi-account behavior)은 **의도적으로, 명시적으로 별개의 설계**를 갖고 있다: "`AWSopsReadOnlyRole`
> itself gains no new permissions... a role whose name is a declared read-only invariant does not carry
> write-capable actions under any attachment method." spec은 대신 완전히 새로운 role
> (`AWSopsSgRuleAthenaRole`)을 대상 계정에 만들고, **공유 Fargate worker task role이 그 role을 assume해서는
> 안 된다**고까지 명시한다(그러면 이 기능과 무관한 다른 job 타입까지 Athena 접근 범위에 들어간다) — 전용
> task role/task definition 또는 broker Lambda 중 하나로 격리해야 한다(구현 전 결정 필요, spec에 미결로
> 남아있음). 이 두 설계는 양립 불가능하다: 이 ADR의 원안대로 `AWSopsReadOnlyRole`에 붙이면 spec이 명시적으로
> 금지하는 바로 그 일을 하게 된다. **아래는 spec의 실제 설계를 반영해 정정한 버전이다.**

두 개의 서로 다른 cross-account grant가 있으며 섞이지 않는다:

1. **`ec2:DescribeSecurityGroupRules`/`DescribeNetworkInterfaces` 등 (일일 rule 인벤토리)** — 이미 web
   task role(`workload.tf:172-186`), Steampipe task role(`steampipe.tf:145-154`), agent Lambda execution
   role(`ai.tf:743-748`, `ai.tf:382-386`)이 사용하는 `arn:aws:iam::*:role/AWSopsReadOnlyRole`
   `sts:AssumeRole`를 그대로 재사용한다 — 전부 같은 role 이름, 같은 read-only 신뢰 경계. 이 부분만 "이미
   검증된 패턴의 새 호출자"라는 원래 §4의 논거가 정확히 적용된다.
2. **Athena/Glue read-query + 결과 prefix S3 write (일일 활동 파이프라인)** — spec이 설계한 대로, 대상
   계정의 **완전히 새로운, 격리된 role**(`AWSopsSgRuleAthenaRole`)을 assume한다. `AWSopsReadOnlyRole`은
   건드리지 않는다(그 이름 자체가 read-only 불변식이므로 write-capable 동사를 어떤 방식으로도 얹지
   않는다). 이 role은 공유 워커 task role이 assume해서는 안 되며, 전용 task role/task definition 또는
   broker Lambda로 assume 주체를 그 기능 하나로 격리한다(spec §IAM 참조 — 구현 시점에 둘 중 하나를 확정).

이 role이 "새로운" 것이라는 사실 자체가 ADR-005/007 분류를 바꾸지는 않는다 — §3/§3b의 논거(동사 스코프 +
prefix 스코프 + SQL 제약)는 role 이름과 무관하게 그대로 성립한다. 이 ADR이 정정하는 것은 오직 "어느
role에 무엇이 붙는가"이며, "그것이 read-only 불변식 내부인가"라는 결론은 바뀌지 않는다.

Two distinct cross-account grants exist, and they must not be conflated:

1. **`ec2:DescribeSecurityGroupRules`/`DescribeNetworkInterfaces` etc. (daily rule inventory)** — reuses
   `sts:AssumeRole` on `arn:aws:iam::*:role/AWSopsReadOnlyRole` exactly as the web task role
   (`workload.tf:172-186`), the Steampipe task role (`steampipe.tf:145-154`), and the agent Lambda
   execution role (`ai.tf:743-748`, `ai.tf:382-386`) already do — same role name, same read-only trust
   boundary. Only this part is "a new caller of an already-vetted pattern," §4's original argument.
2. **Athena/Glue read-query plus the result-prefix S3 write (daily activity pipeline)** — assumes a
   wholly new, isolated role in the target account (`AWSopsSgRuleAthenaRole`), as the spec designs.
   `AWSopsReadOnlyRole` is untouched — its name is itself the read-only invariant, so it never carries a
   write-capable verb under any attachment method. This role must not be assumable by the shared worker
   task role; a dedicated task role/task definition or a broker Lambda isolates the assuming principal
   to this one feature (see the spec's own §IAM — the choice between the two is still open at
   implementation time).

The role being "new" does not, by itself, change the ADR-007 classification — §3/§3b's argument
(verb scope + prefix scope + SQL constraint) holds regardless of which role carries the grant. What this
ADR corrects is only *which* role carries *what*. It does not change §Decision below: Role B's write
grant is registered as an explicit ADR-005 owner-override exception, not waved through as "no
relaxation needed."

## Decision / 결정

**역할 A(rule 인벤토리, `AWSopsReadOnlyRole` 재사용)는 기존 read-only 불변식(BASELINE §1) 내부에 있으며 예외가 필요 없다. 역할 B(Athena/S3 write, `AWSopsSgRuleAthenaRole`)는 ADR-007 티어가 아니며, ADR-005 동결에 대한 좁고·명시적이고·날짜박힌 owner-override 예외로 등록한다(ADR-015 패턴) — §3b의 세 통제가 모두 유지되는 동안만 유효하다.**

**Role A (rule inventory, reusing `AWSopsReadOnlyRole`) sits inside the existing read-only invariant
(BASELINE §1) and needs no exception. Role B (Athena/S3 write, `AWSopsSgRuleAthenaRole`) is not
ADR-007-tier, and is registered as a narrow, explicit, dated owner-override exception to the ADR-005
freeze (the ADR-015 pattern) — valid only while all three §3b controls hold.**

> **2026-08-19 patch (panel review):** the list below now explicitly ratifies the one write-shaped
> grant this feature actually needs (`s3:PutObject`/`AbortMultipartUpload`, scoped to the customer's
> own pre-configured result prefix) instead of leaving it implied only by the exclusion list's
> wording — Athena's own service mechanics require it (§3b); hiding it here would either break the
> feature or force a future PR to add it without this ADR's coverage.

허용되는 것 — **역할 A: 재사용되는 `AWSopsReadOnlyRole`** (일일 rule 인벤토리) / Permitted — **Role A:
the reused `AWSopsReadOnlyRole`** (daily rule inventory):
- `sts:AssumeRole` → `arn:aws:iam::*:role/AWSopsReadOnlyRole` (기존 패턴, worker role로 확장)
- `ec2:DescribeSecurityGroupRules`, `ec2:DescribeNetworkInterfaces`(기존 패턴), `ec2:DescribeFlowLogs`

- `sts:AssumeRole` → `arn:aws:iam::*:role/AWSopsReadOnlyRole` (existing pattern, extended to the
  worker)
- `ec2:DescribeSecurityGroupRules`, `ec2:DescribeNetworkInterfaces` (existing pattern),
  `ec2:DescribeFlowLogs`

허용되는 것 — **역할 B: 신규 격리된 `AWSopsSgRuleAthenaRole`** (일일 Athena 활동 파이프라인,
`AWSopsReadOnlyRole`과 전혀 별개) / Permitted — **Role B: the new, isolated
`AWSopsSgRuleAthenaRole`** (daily Athena activity pipeline, wholly separate from
`AWSopsReadOnlyRole`):
- `sts:AssumeRole` → 대상 계정의 `AWSopsSgRuleAthenaRole` (신규 role — spec §IAM 설계대로, 전용 task
  role/task definition 또는 broker Lambda로만 assume 가능, 공유 워커 task role은 assume 불가). **신뢰
  정책 요구사항(spec §IAM "Trust policy"):** 대상 계정의 `AWSopsSgRuleAthenaRole` 신뢰 정책은 (a)
  `ExternalId` 조건, (b) 호스트 계정의 Athena-worker identity(전용 task role 또는 broker Lambda)로
  제한된 명시적 principal ARN을 **모두** 요구한다 — wildcard principal 금지, `ExternalId` 누락 금지.
  **정정(2026-08-19, 3라운드 패널):** 이 저장소의 기존 cross-account read-only role은 오히려
  `ExternalId`가 없는 경우가 있다(`steampipe.tf`, 1st-party 경로, ADR-011 완화) — 그러니 여기 요구는
  "기존 관례 계승"이 아니라, **이 write-capable role 하나에 대해 그 완화를 명시적으로 되돌리는
  더 엄격한 예외**다. 이 두 조건이 없으면 read-only sibling role은 겪지 않는 confused-deputy 위험이
  생긴다.
- `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`, `athena:StopQueryExecution`, `athena:GetWorkGroup` — **§3b의 세 통제(SELECT-only 생성 SQL, mutating Glue 동사 배제, 아래 S3 read/write 스코프)가 모두 유지되는 조건 하에서만** read-only로 간주
- `glue:GetDatabase`, `glue:GetTable`, `glue:GetPartitions`
- `s3:GetBucketLocation`
- **`s3:GetObject`, `s3:ListBucket` (소스 위치) — spec §IAM이 규정한 "configured Flow Log table
  locations"(Glue 테이블이 가리키는 실제 소스 데이터 위치)에 한정. 이것이 SQL 쿼리가 실제로 읽는
  데이터이며, 워크그룹의 결과 prefix와는 별개의(계정·버킷이 다를 수도 있는) 위치다.**
- **`s3:GetObject`, `s3:ListBucket`, `s3:PutObject`, `s3:AbortMultipartUpload` (결과 prefix) — 고객
  워크그룹의 사전 설정된 **결과** prefix에만 한정. write(`PutObject`/`AbortMultipartUpload`)는 Athena
  쿼리 실행 자체가 요구하는 필수 동작이며(§3의 "서비스 내부 메커니즘" 논거가 정확히 이 grant를
  가리킨다). **read(`GetObject`/`ListBucket`)도 이 prefix에 함께 필요하다** — Athena 자신이
  `GetQueryResults` 처리와 (활성화된 경우) 쿼리 결과 재사용(result reuse) 판단을 위해 자신이 쓴 결과
  객체를 다시 읽기 때문이다. 소스 위치와 결과 prefix는 여전히 서로 다른 위치이지만, 결과 prefix
  **자체는** read+write 둘 다 필요하다 — write만 부여하면 실제로 동작하지 않는다. AWSops는 이 prefix
  바깥으로는 결코 write하지 않으며, 그 버킷/워크그룹을 생성·삭제하지 않는다.**

- `sts:AssumeRole` → the target account's `AWSopsSgRuleAthenaRole` (a new role — per the spec's
  §IAM design, assumable only by a dedicated task role/task definition or a broker Lambda; the
  shared worker task role may not assume it). **Trust policy requirement (spec §IAM "Trust
  policy"):** the target account's `AWSopsSgRuleAthenaRole` trust policy must require BOTH (a) an
  `ExternalId` condition and (b) an explicit principal ARN restriction to the host account's
  Athena-worker identity (the dedicated task role or broker Lambda) — no wildcard principal, no
  missing `ExternalId`. **Correction (2026-08-19, round-3 panel):** this repo's *existing*
  cross-account read-only role sometimes has no `ExternalId` at all (`steampipe.tf`, the 1st-party
  path, per ADR-011's relaxation) — so this requirement is not "inheriting existing convention," it
  is a **stricter override reversing that relaxation for this one write-capable role specifically**.
  Without both conditions, this role carries a confused-deputy risk its read-only sibling never had.
- `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`,
  `athena:StopQueryExecution`, `athena:GetWorkGroup` — treated as read-only **only while all three
  §3b controls hold** (SELECT-only generated SQL, mutating Glue verbs excluded, the S3 read/write
  scope below)
- `glue:GetDatabase`, `glue:GetTable`, `glue:GetPartitions`
- `s3:GetBucketLocation`
- **`s3:GetObject`, `s3:ListBucket` (source location) — scoped to the spec §IAM's "configured Flow
  Log table locations" (the actual source data location the Glue table points at). This is the
  data the SQL query actually reads, and it is a distinct location from the result prefix below
  (potentially a different account/bucket entirely).**
- **`s3:GetObject`, `s3:ListBucket`, `s3:PutObject`, `s3:AbortMultipartUpload` (result prefix) —
  scoped ONLY to the customer workgroup's own pre-configured result prefix. The write half
  (`PutObject`/`AbortMultipartUpload`) is a required mechanic of running an Athena query at all
  (§3's "the service's own internal mechanism" argument is precisely about this grant). **The read
  half (`GetObject`/`ListBucket`) is ALSO required on this same prefix** — Athena itself reads back
  the result objects it wrote, both to serve `GetQueryResults` and (when enabled) to evaluate query
  result reuse. The source location and the result prefix remain distinct locations, but the result
  prefix itself needs both read and write — write-only would not actually work.** AWSops never
  writes outside this prefix and never creates or deletes that bucket/workgroup.

명시적으로 금지되는 것 / Explicitly excluded:
- `athena:CreateWorkGroup`/`UpdateWorkGroup`/`DeleteWorkGroup`, `glue:CreateTable`/`CreateDatabase`/`DeleteTable`/`DeleteDatabase`
- **어떤 형태로도 사용자/운영자가 제출한 SQL을 그대로 실행하는 경로** — 제출되는 쿼리는 항상 검증된 스키마 위에서 워커가 자체 생성한 SELECT여야 한다(§3b 통제 1)
- 고객 워크그룹 결과 prefix **바깥으로의** `s3:PutObject`/`s3:DeleteObject`, 그리고 어떤 prefix에서도 `s3:DeleteObject` — AWSops는 그 버킷의 소유자·관리자가 아니며 결과 정리는 고객의 워크그룹 lifecycle 설정에 맡긴다
- 소스 설정에 등록된 **Flow Log table 위치**와 **워크그룹 결과 prefix**, 이 두 곳 **바깥으로의**
  `s3:GetObject`/`s3:ListBucket` — 읽기 범위도 write 범위만큼 좁게 스코프되어야 하며, 계정/버킷 전역
  read 권한을 부여하지 않는다. (결과 prefix 자체에 대한 `GetObject`/`ListBucket`은 §Decision 위에서
  명시적으로 허용된다 — 이 항목이 금지하는 것은 그 두 위치를 벗어난 read다.)
- `ec2:RevokeSecurityGroupIngress`/`Egress`, `ec2:AuthorizeSecurityGroupIngress`/`Egress` 및 그 어떤 mutating EC2 동사
- `iam:CreateRole`/`PassRole`(역할 A·B 어느 쪽에 대해서도; 둘 다 기존 신뢰 관계 assume만)
- **공유 Fargate worker task role에 `AWSopsSgRuleAthenaRole`로의 `sts:AssumeRole` 직접 부여** — 이 role은
  전용 task role/task definition 또는 broker Lambda로만 assume 가능해야 하며, 공유 role에 부여하면 이
  기능과 무관한 다른 모든 job 타입이 Athena 접근 범위에 들어간다(§4 참조)
- **`s3:PutBucketPolicy`/`s3:PutBucketAcl`/`s3:PutObjectAcl`/`s3:DeleteBucketPolicy` 및 그 밖의 모든
  bucket-policy·ACL write 동사** — spec §IAM이 명시적으로 배제한다. 이 role은 버킷의 접근 정책 자체를
  건드리지 않으며, 오직 그 안의 객체를 화이트리스트된 prefix 안에서 read/write할 뿐이다.
- **`AWSopsSgRuleAthenaRole`의 신뢰 정책에 wildcard principal(`"Principal": "*"` 또는 계정 전체)을
  허용하거나 `ExternalId` 조건을 생략** — 위 Permitted 섹션의 신뢰 정책 요구사항 참조. 둘 중 하나라도
  빠지면 confused-deputy 리스크가 생긴다.

- `athena:CreateWorkGroup`/`UpdateWorkGroup`/`DeleteWorkGroup`, `glue:CreateTable`/`CreateDatabase`/`DeleteTable`/`DeleteDatabase`
- **any path that executes user/operator-submitted SQL verbatim** — every submitted query must be
  the worker's own validation-generated SELECT over the validated schema (§3b control 1)
- `s3:PutObject`/`s3:DeleteObject` **outside** the customer workgroup's own result prefix, and
  `s3:DeleteObject` in any prefix — AWSops is never that bucket's owner or administrator; result
  cleanup is left to the customer's own workgroup lifecycle configuration
- `s3:GetObject`/`s3:ListBucket` **outside** both the source's registered Flow Log table location
  AND the workgroup's result prefix — read scope must stay as narrow as write scope, no
  account-wide or bucket-wide read grant. (`GetObject`/`ListBucket` ON the result prefix itself is
  explicitly permitted above — this exclusion is about read leaking outside those two locations,
  not about the result prefix's own read grant.)
- `ec2:RevokeSecurityGroupIngress`/`Egress`, `ec2:AuthorizeSecurityGroupIngress`/`Egress`, and any
  other mutating EC2 verb
- `iam:CreateRole`/`PassRole` for either role — both only assume an existing trust relationship
- **Granting the shared Fargate worker task role a direct `sts:AssumeRole` on
  `AWSopsSgRuleAthenaRole`** — that role must be assumable only via a dedicated task role/task
  definition or a broker Lambda; granting it to the shared role would expose every other job type
  this worker fleet runs to Athena access it has no business needing (see §4)
- **`s3:PutBucketPolicy`/`s3:PutBucketAcl`/`s3:PutObjectAcl`/`s3:DeleteBucketPolicy` and any other
  bucket-policy/ACL write verb** — explicitly excluded per the spec's own §IAM. This role never
  touches a bucket's access policy itself, only reads/writes objects within its allowlisted
  prefixes.
- **A trust policy on `AWSopsSgRuleAthenaRole` with a wildcard principal (`"Principal": "*"` or an
  account-wide principal) or a missing `ExternalId` condition** — see the trust-policy requirement
  in Permitted above; either omission reopens a confused-deputy risk.

이에 따라 `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`의 Feature Gate / IAM 절은 정정된다: `sg_rule_activity_enabled`는 ADR-007 티어가 아니며, "일반 GATED"도 아니다 — 이 ADR이 등록하는 **좁은 owner-override 예외**가 정확히 그 grant(역할 B, Athena/S3 write)에 적용되는 조건부 GATED 항목이다(`docs/decisions/BASELINE.md` §2, "GATED(owner-override 예외)" — ADR-015 행과 같은 표기, default OFF, `workers_enabled` 선행 요구). **이 ADR은 `docs/superpowers/specs/2026-08-13-network-path-check-design.md`나 `network_path_check_enabled`를 다루지 않는다** — 그 spec은 이 ADR과 무관하게 자체 남은 조건(BASELINE §2 행 + adapter-safety 재검토 1회)만으로 Approved 전환되었으며, BASELINE §2의 해당 행은 근거 ADR을 "—"로 표기한다.

Accordingly, the Feature Gate / IAM section of
`docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md` is corrected:
`sg_rule_activity_enabled` is neither ADR-007-tier nor an ordinary GATED entry — it is a
conditional GATED entry covered by this ADR's narrow owner-override exception (applying to exactly
Role B's Athena/S3 write grant): `docs/decisions/BASELINE.md` §2, labeled "GATED(owner-override
예외)" the same way as the ADR-015 row, default OFF, requires `workers_enabled`. **This ADR does
not cover `docs/superpowers/specs/2026-08-13-network-path-check-design.md` or
`network_path_check_enabled` at all** — that spec moved to Approved on its own remaining conditions
(a BASELINE §2 row + one adapter-safety review pass), independent of this ADR, and its BASELINE §2
row records its 근거 ADR as "—".

## Consequences / 결과

### Positive / 긍정
- SG Rules 기능이 존재하지 않는 governance 절차(ADR-007 확장) 없이, 이미 검증된 read-only 불변식 아래에서 진행 가능해진다.
- Enables the SG Rules feature to proceed under the already-vetted read-only invariant, with no
  need to invent a new ADR-007-tier governance track.
- IAM 표면이 역할 A(read-only 동사만)와 역할 B(read/query 동사 + 명시적으로 스코프된 1건의 write)로 명확히 분리되어, 향후 리뷰가 이 ADR을 기준으로 mutating 동사 유입 또는 두 role의 경계 침범을 즉시 걸러낼 수 있다.
- The IAM surface is cleanly split between Role A (read-only verbs only) and Role B (read/query
  verbs plus the one explicitly scoped write) — future reviewers have a bright line to reject any
  mutating verb, or any blurring of the boundary between the two roles.

### Negative / Trade-offs
- Athena 비용(스캔 바이트당 과금)은 read-only 이지만 예산에 영향을 준다. **정정(2026-08-19, 3라운드
  패널):** 이전 초안은 이 통제가 spec에 이미 명시돼 있다고 인용했으나, 그 시점의 spec에는 어디에도
  존재하지 않았다(grep으로 확인). spec의 "Flow Log source configuration" §"Cost, result-location,
  and workgroup validation preconditions"에 `sg_rule_activity_max_query_bytes`(기본 100 GiB) 변수와
  워크그룹 `EnforceWorkGroupConfiguration`+`BytesScannedCutoffPerQuery` 요구사항을 이 PR에서 신설
  추가했다 — "이미 규정됨"이 아니라 "이 PR에서 처음 규정함"이 맞는 서술이다.
- Athena cost (billed per byte scanned) is read-only but has budget impact. **Correction (2026-08-19,
  round-3 panel):** an earlier draft cited this control as already specified in the spec — it existed
  nowhere at that point (grep-confirmed). The spec's "Flow Log source configuration" §"Cost,
  result-location, and workgroup validation preconditions" now **introduces**
  `sg_rule_activity_max_query_bytes` (default 100 GiB) and requires the workgroup's
  `EnforceWorkGroupConfiguration` + `BytesScannedCutoffPerQuery` — added in this same PR, not
  pre-existing.
- **역할 A**(rule 인벤토리)는 이미 검증된 `AWSopsReadOnlyRole` 신뢰 경계에 새 호출자를 추가할 뿐이지만, **역할 B**(`AWSopsSgRuleAthenaRole`)는 이 저장소에서 **최초로 write-capable한 cross-account 신뢰 관계**다 — read-only로 명명된 기존 sibling role과 달리, 이 role 자체가 손상되면 (스코프된) write 능력이 노출된다. 완화책은 role의 좁은 스코프(prefix 한정 S3 write, 화이트리스트된 Athena/Glue 동사)와 assume 주체 격리(전용 task role 또는 broker Lambda, 공유 워커 task role 배제)뿐이며, "read-only sibling과 같은 수준의 잔여 리스크"라고 주장할 수 없다 — 이건 다른, 더 큰 범주의 신뢰다.
- **Role A** (rule inventory) only adds a new caller to the already-vetted `AWSopsReadOnlyRole`
  trust boundary, but **Role B** (`AWSopsSgRuleAthenaRole`) is the **first write-capable
  cross-account trust relationship** in this repository — unlike its read-only-named sibling, a
  compromise of this role exposes (scoped) write capability, not just read. The mitigations are the
  role's narrow scope (prefix-only S3 write, an allowlisted set of Athena/Glue verbs) and isolating
  who may assume it (a dedicated task role or broker Lambda, never the shared worker task role) —
  this is not "the same residual risk every existing caller already carries"; it is a genuinely
  larger category of trust.

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Security**: 역할 A는 read-only 동사만 화이트리스트. 역할 B는 read/query 동사 + 두 개의 독립적으로 스코프된 S3 영역만 화이트리스트 — Flow Log 소스 위치(read만)와 워크그룹 결과 prefix(read+write 둘 다, Athena 자신이 자기가 쓴 결과를 다시 읽기 때문). 두 영역은 서로 다른(계정이 다를 수도 있는) 위치이며 섞이지 않는다. mutating 동사 명시적 배제, assume 주체를 전용 task role/broker Lambda로 격리(공유 워커 task role 배제). 역할 A의 cross-account 확장은 기존 신뢰 경계 재사용이지만, 역할 B는 이 저장소 최초의 write-capable cross-account 신뢰 관계임을 명시(위 Negative 참조).
- **Reliability**: CloudWatch Logs Insights와 동일한 폴링+타임아웃+`StopQueryExecution` 취소 패턴 재사용 — 새 실패 모드 없음.
- **Operational Excellence**: 이 ADR(3라운드 멀티-AI 패널 리뷰, ADR-015 패턴의 owner-override 예외로 재프레이밍) + owner 승인으로 spec이 요구한 "새 ADR + 패널 + 날짜박힌 owner-override" 절차 완전 충족. BASELINE §2에 `sg_rule_activity_enabled`를 GATED(owner-override 예외)로 등록(같은 PR) — 플래그 자체는 미구현이므로 승인됨·미구현으로 명시.
- **Cost**: 기본 OFF; 켜져도 이 PR에서 spec에 신설한 `sg_rule_activity_max_query_bytes` 스캔 바이트 상한 + 워크그룹 `EnforceWorkGroupConfiguration`/`BytesScannedCutoffPerQuery` 검증으로 통제.
- **Performance/Sustainability**: 일 1회 배치 쿼리(소스당), 상시 자원 추가 없음(워커 role IAM 정책 외).
