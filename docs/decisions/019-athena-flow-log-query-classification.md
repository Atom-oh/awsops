# ADR-019: Athena/Glue Flow Log 조회는 기존 read-only 불변식 내부 / Athena/Glue Flow Log Queries Fall Inside the Existing Read-Only Invariant

## Status / 상태

**Draft — 멀티-AI 패널 리뷰 대기 중 (Owner: 오준석, 2026-08-19, `/co-agent:consensus` 세션에서 요청).**
패널이 CRITICAL/MAJOR를 발견하지 않으면 Accepted로 전환한다. 이 ADR은 `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`가 "새 ADR을 통해서만 해소된다"고 명시한 ADR-005/ADR-007 분류 질문을 다룬다.

**Draft — pending multi-AI panel review (Owner: 오준석/Junseok Oh, 2026-08-19, requested inside a `/co-agent:consensus` session).** Moves to Accepted once the panel finds no CRITICAL/MAJOR. This ADR resolves the ADR-005/ADR-007 classification question that `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md` states can only be settled by a new ADR.

## Context / 컨텍스트

`docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`는 SG Rules 기능(일일 `DescribeSecurityGroupRules`/`DescribeNetworkInterfaces` 인벤토리 + Athena 기반 90일 트래픽 증거 파이프라인)이 두 가지 신규 능력을 필요로 한다고 밝힌다: (1) `athena:StartQueryExecution`/`StopQueryExecution` + 고객이 사전 설정한 워크그룹 결과 위치로의 S3 write, (2) 현재 P2 워커 role(`worker_task`/`worker_lambda`)에는 전혀 없는 `sts:AssumeRole`(`arn:aws:iam::*:role/AWSopsReadOnlyRole`). spec 작성자는 이를 "ADR-007-tier"(외부 DATA write)로 자체 분류했으나, 그 분류가 **본인의 추론일 뿐 비준된 결정이 아님**을 spec 스스로 인정하며, ADR-015 선례(새 ADR + 멀티-AI 패널 + 날짜박힌 owner-override)를 요구했다.

The SG Rules feature's daily rule-inventory scan plus its Athena-based 90-day traffic-evidence
pipeline needs two capabilities the codebase does not have today: (1) `athena:StartQueryExecution`/
`StopQueryExecution` plus an S3 write into a customer-pre-configured workgroup result location, and
(2) `sts:AssumeRole` on `arn:aws:iam::*:role/AWSopsReadOnlyRole` from the P2 worker roles
(`worker_task`/`worker_lambda`), which currently hold zero cross-account grant. The spec's own author
self-classified this as "ADR-007-tier" (external DATA write) but explicitly flagged that
classification as unratified reasoning, not a decision, and required the ADR-015-style instrument
(new ADR + multi-AI panel + dated owner-override) to settle it.

이 ADR은 그 분류 질문 자체를 다시 검토한다. **결론: 이 두 능력 모두 ADR-007의 "외부 DATA" 범주에 속하지 않으며, ADR-005의 완화도 필요 없다 — 둘 다 이미 라이브인 기존 패턴의 새로운 인스턴스일 뿐이다.**

This ADR re-examines the classification question itself. **Conclusion: neither capability belongs
to ADR-007's "external DATA" category, and neither requires relaxing ADR-005 — both are new
instances of patterns already live in production.**

### 1. Athena/Glue 는 "외부 DATA" 가 아니라 AWS-네이티브 데이터 서비스다 / Athena/Glue are AWS-native, not "external DATA"

ADR-007의 "외부 DATA"는 AWS 바깥의 제3자 SaaS(Slack, Notion, Jira, 외부 관측성 플랫폼)를 가리킨다 — AWS 계정 경계를 넘어 신뢰를 확장하는 것이 그 조항의 위험 모델이다. Athena·Glue·S3는 고객이 이미 온보딩한 **같은 AWS 계정 안의** AWS 네이티브 서비스다. 이들에 대한 read-query 호출은 `DescribeSecurityGroupRules`나 `logs:StartQuery`(CloudWatch Logs Insights)와 동일한 신뢰 경계 안에 있다.

ADR-007's "external DATA" means third-party SaaS outside AWS (Slack, Notion, Jira, external
observability platforms) — its risk model is about extending trust across the AWS account boundary.
Athena, Glue, and S3 are AWS-native services **inside the same already-onboarded AWS account**.
Read-query calls against them sit inside the exact same trust boundary as `DescribeSecurityGroupRules`
or CloudWatch Logs Insights' `logs:StartQuery`.

### 2. 정확히 같은 형태의 패턴이 이미 라이브다 / The exact same shape of pattern is already live

`web/lib/dns-logs.ts`, `web/lib/anfw-logs.ts`, `web/lib/nfm.ts`는 이미 CloudWatch Logs Insights의 `StartQueryCommand` → 폴링 → `GetQueryResultsCommand` (+ 데드라인 시 `StopQueryCommand`)를 사용해 로그 데이터를 비동기 조회한다 — 어떤 ADR-005/007 논쟁도 거치지 않고 라이브다. Athena의 `StartQueryExecution` → 폴링 → `GetQueryResults` (+ `StopQueryExecution`)는 **구조적으로 동일한 패턴**이다: 비동기 조회를 시작하고, 결과를 가져오고, 필요시 취소한다. 유일한 차이는 로그 저장소가 CloudWatch Logs가 아니라 S3(Athena/Glue 카탈로그 경유)라는 것뿐이며, 이는 조회 대상 데이터의 위치이지 조회 행위의 성격을 바꾸지 않는다.

`web/lib/dns-logs.ts`, `web/lib/anfw-logs.ts`, and `web/lib/nfm.ts` already run CloudWatch Logs
Insights' `StartQueryCommand` → poll → `GetQueryResultsCommand` (+ `StopQueryCommand` on deadline) to
query log data asynchronously — live today, without any ADR-005/007 debate. Athena's
`StartQueryExecution` → poll → `GetQueryResults` (+ `StopQueryExecution`) is **structurally the same
pattern**: start an async query, fetch results, cancel if needed. The only difference is that the
log store is S3 (via the Athena/Glue catalog) instead of CloudWatch Logs — a difference in where the
queried data lives, not in the nature of the query action.

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

### 4. Cross-account read-only role assumption은 새 캐퍼빌리티가 아니라 기존 패턴의 새 호출자다 / Cross-account read-only assumption is a new CALLER of an existing pattern, not a new capability

`arn:aws:iam::*:role/AWSopsReadOnlyRole`로의 `sts:AssumeRole`은 이미 web task role(`workload.tf:172-186`), Steampipe task role(`steampipe.tf:145-154`), agent Lambda execution role(`ai.tf:743-748`, `ai.tf:382-386`)에 존재한다 — 전부 같은 role 이름, 같은 read-only 신뢰 경계. P2 워커 role에 동일 grant를 추가하는 것은 새 아키텍처 능력이 아니라 이미 검증된 패턴에 새 호출자를 추가하는 것이다.

`sts:AssumeRole` on `arn:aws:iam::*:role/AWSopsReadOnlyRole` already exists on the web task role
(`workload.tf:172-186`), the Steampipe task role (`steampipe.tf:145-154`), and the agent Lambda
execution role (`ai.tf:743-748`, `ai.tf:382-386`) — all the same role name, the same read-only trust
boundary. Adding the identical grant to the P2 worker roles is not a new architectural capability;
it's a new caller of an already-vetted pattern.

## Decision / 결정

**SG Rules & Usage의 일일 인벤토리 + Athena 기반 활동 파이프라인은 기존 read-only 불변식(BASELINE §1) 내부에 있다. ADR-005 완화도, ADR-007 티어 분류도 필요 없다.**

**The SG Rules & Usage daily inventory + Athena-based activity pipeline sits inside the existing
read-only invariant (BASELINE §1). It needs neither an ADR-005 relaxation nor an ADR-007-tier
classification.**

허용되는 것 (read/query verb만) / Permitted (read/query verbs only):
- `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`, `athena:StopQueryExecution`, `athena:GetWorkGroup`
- `glue:GetDatabase`, `glue:GetTable`, `glue:GetPartitions`
- `s3:GetBucketLocation`, `s3:GetObject`(고객 워크그룹 결과 prefix 한정), `s3:ListBucket`(동일 prefix)
- `ec2:DescribeSecurityGroupRules`, `ec2:DescribeNetworkInterfaces`(기존 패턴), `ec2:DescribeFlowLogs`
- `sts:AssumeRole` → `arn:aws:iam::*:role/AWSopsReadOnlyRole` (기존 패턴, worker role로 확장)

명시적으로 금지되는 것 / Explicitly excluded:
- `athena:CreateWorkGroup`/`UpdateWorkGroup`/`DeleteWorkGroup`, `glue:CreateTable`/`CreateDatabase`/`DeleteTable`/`DeleteDatabase`
- 고객 워크그룹 결과 prefix 바깥으로의 `s3:PutObject`/`s3:DeleteObject` — AWSops는 그 버킷의 소유자·관리자가 아니다
- `ec2:RevokeSecurityGroupIngress`/`Egress`, `ec2:AuthorizeSecurityGroupIngress`/`Egress` 및 그 어떤 mutating EC2 동사
- `iam:CreateRole`/`PassRole`(worker role에 대해; 기존 read-only 신뢰 관계만 assume)

- `athena:CreateWorkGroup`/`UpdateWorkGroup`/`DeleteWorkGroup`, `glue:CreateTable`/`CreateDatabase`/`DeleteTable`/`DeleteDatabase`
- `s3:PutObject`/`s3:DeleteObject` outside the customer workgroup's own result prefix — AWSops is
  never that bucket's owner or administrator
- `ec2:RevokeSecurityGroupIngress`/`Egress`, `ec2:AuthorizeSecurityGroupIngress`/`Egress`, and any
  other mutating EC2 verb
- `iam:CreateRole`/`PassRole` for the worker role — it only assumes the existing read-only trust
  relationship

이에 따라 `docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md`의 Feature Gate / IAM 절은 정정된다: `sg_rule_activity_enabled`는 ADR-007 티어가 아니라 **일반 GATED 항목**(`docs/decisions/BASELINE.md` §2, 다른 신규 기능 게이트와 동일한 취급 — default OFF, `workers_enabled` 선행 요구)이다. `docs/superpowers/specs/2026-08-13-network-path-check-design.md`(read-only 정적 분석만 사용, Athena/Reachability Analyzer 없음)는 이 ADR에 영향받지 않으며 자체 남은 조건(BASELINE §2 행 + adapter-safety 재검토 1회)만 충족하면 된다.

Accordingly, the Feature Gate / IAM section of
`docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md` is corrected:
`sg_rule_activity_enabled` is not ADR-007-tier — it is an **ordinary GATED entry**
(`docs/decisions/BASELINE.md` §2, treated the same as any other new-feature gate: default OFF,
requires `workers_enabled`). `docs/superpowers/specs/2026-08-13-network-path-check-design.md` (which
uses only read-only static analysis, no Athena, no Reachability Analyzer) is unaffected by this ADR
and needs only its own remaining conditions (a BASELINE §2 row + one adapter-safety review pass).

## Consequences / 결과

### Positive / 긍정
- SG Rules 기능이 존재하지 않는 governance 절차(ADR-007 확장) 없이, 이미 검증된 read-only 불변식 아래에서 진행 가능해진다.
- Enables the SG Rules feature to proceed under the already-vetted read-only invariant, with no
  need to invent a new ADR-007-tier governance track.
- IAM 표면이 명시적으로 read/query 동사로만 한정되어, 향후 리뷰가 이 ADR을 기준으로 mutating 동사 유입을 즉시 걸러낼 수 있다.
- Explicitly scoping the IAM surface to read/query verbs gives future reviewers a bright line to
  reject any mutating verb creeping into the same policy statement.

### Negative / Trade-offs
- Athena 비용(스캔 바이트당 과금)은 read-only 이지만 예산에 영향을 준다 — spec의 `sg_rule_activity_max_query_bytes`(기본 100 GiB) 및 워크그룹 `BytesScannedCutoffPerQuery` 요구사항으로 통제된다(이 ADR이 신설하지 않음, spec이 이미 규정).
- Athena cost (billed per byte scanned) is read-only but has budget impact — controlled by the
  spec's own `sg_rule_activity_max_query_bytes` (default 100 GiB) and workgroup
  `BytesScannedCutoffPerQuery` requirement (not introduced by this ADR; already specified).
- 워커 role이 처음으로 cross-account read-only 신뢰를 얻는다 — blast radius는 여전히 `AWSopsReadOnlyRole`(read-only으로 명명·설계된 role)로 제한되지만, 향후 그 role 자체가 손상되면 워커도 노출 표면이 된다(다른 모든 기존 호출자와 동일한 잔여 리스크).
- The worker role gains cross-account read-only trust for the first time — blast radius stays
  bounded by `AWSopsReadOnlyRole` (named and designed as read-only), but if that role were ever
  compromised, the worker becomes part of the exposure surface (the same residual risk every other
  existing caller already carries).

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Security**: IAM 액션을 read/query 동사로 화이트리스트, mutating 동사 명시적 배제. Athena 결과 write는 고객 워크그룹의 사전 설정된 prefix에만(AWSops가 만들거나 통제하는 버킷 없음). cross-account role 확장은 기존 신뢰 경계 재사용, 새 신뢰 관계 없음.
- **Reliability**: CloudWatch Logs Insights와 동일한 폴링+타임아웃+`StopQueryExecution` 취소 패턴 재사용 — 새 실패 모드 없음.
- **Operational Excellence**: 이 ADR + 멀티-AI 패널 리뷰로 spec이 요구한 governance 절차 충족. BASELINE §2에 `sg_rule_activity_enabled`를 일반 GATED 항목으로 등록(같은 PR).
- **Cost**: 기본 OFF; 켜져도 스캔 바이트 상한 + 워크그룹 컷오프로 통제.
- **Performance/Sustainability**: 일 1회 배치 쿼리(소스당), 상시 자원 추가 없음(워커 role IAM 정책 외).
