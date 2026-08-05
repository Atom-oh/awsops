# ADR-007: 외부 데이터 통합 거버넌스 (keystone — read-only는 '리소스' 한정, 외부 DATA는 거버넌스 하 read+write) / External Data Integration Governance (keystone — "read-only" means RESOURCE, external DATA is read+write under governance)

## Status / 상태

Accepted (2026-06-22) — consolidated. consolidates: 011, 031(P3 BYO-MCP), 039, 040, 041. **단, ADR-041 keystone 재정의는 owner-override이며 멀티-AI 패널 verdict = PARTIAL (2026-06-16)** — 외부-write 결과는 ADR-040 패널이 비준했으나 "reversal은 external-endpoint 대상 아님"이라는 사후 재서술은 2026-06-11 합의문과 충돌(이 한정자는 §References가 아니라 Status에 명시). / The ADR-041 re-scope is an owner-override; multi-AI panel verdict = PARTIAL (2026-06-16). **Amended 2026-07-31 (pentest Finding 2/7, round 3 review) — §4/§6.1 write-path attribution corrected.**

> **개정 (2026-07-31, pentest Finding 2/7 라운드 3 리뷰 대응):** §6.1 pillar 1과 이 Status 각주가 `agent.py`의 `_assert_host_allowed`를 외부 DATA **write** 경로의 통제로 잘못 귀속시키고 있었다. 정정: `_assert_host_allowed`의 유일한 호출자는 `_connect_integration()`이며, 그 함수 자체의 docstring이 명시하듯 이는 **egress-READ** integration MCP 세션(ADR-039)을 여는 경로다. 실제 외부 DATA write(Slack/Notion/Jira 등)는 §5가 기술하는 별도의 **lambda executor 분기**(`executor_type='lambda'`, `action_catalog` 경유)가 담당하며 `_assert_host_allowed`를 거치지 않는다. §6.1을 이에 맞게 정정. `BASELINE.md` 갱신 불필요(register 항목 변경 없음, 귀속 정정만).
>
> **Amendment (2026-07-31, pentest Finding 2/7 round-3 review response):** §6.1 pillar 1 and this Status footnote had misattributed `agent.py`'s `_assert_host_allowed` as a control on the external-DATA **write** path. Correction: `_assert_host_allowed`'s only caller is `_connect_integration()`, whose own docstring states it opens an **egress-READ** integration MCP session (ADR-039). Actual external DATA writes (Slack/Notion/Jira, etc.) go through the separate **lambda-executor branch** described in §5 (`executor_type='lambda'`, via `action_catalog`), which never calls `_assert_host_allowed`. §6.1 corrected accordingly. No `BASELINE.md` change needed (no register entry changed, attribution-only fix).

이 ADR은 외부 데이터 통합에 관한 흩어진 결정 4건을 단일 keystone으로 통합한다 — 011(외부 관측 데이터소스 연동), 039(Integrations 축/egress substrate), 040(거버넌스된 외부 knowledge/comms write), 041(keystone 재정의: read-only=리소스 한정). 단일 Status를 가지며, 이전 4개 ADR의 개별 Status·amendment·addendum은 본 문서의 결정으로 대체된다.

This ADR consolidates four scattered decisions on external data integration into one keystone — 011 (external observability datasource integration), 039 (Integrations axis / egress substrate), 040 (governed external knowledge/comms writes), 041 (keystone re-definition: read-only = resource-scoped). It carries a single Status; the individual Status / amendment / addendum histories of those four ADRs are superseded by the decision recorded here.

## Context / 컨텍스트

AWSops는 read-only 운영 대시보드 + AI 진단 제품이다. 동시에 AWS DevOps/Security/FinOps 프런티어 에이전트 패밀리의 통합 모델 — 외부 관측 플랫폼(Prometheus/Loki/Tempo/ClickHouse/Grafana/Datadog)을 read하고, 외부 기록 시스템(Slack/Notion/Confluence/Jira/ServiceNow)에 티켓·노트·메시지를 write하는 — 을 차용하려 한다.

이 두 목표는 "read-only"라는 단어를 어떻게 해석하느냐에 따라 충돌하는 것처럼 보였다. 2026-06-11 고위험 reversal은 "mutation/autonomy/**external-endpoint**" 방향을 동결하며 그 근거로 "egress/SSRF/credential custody"를 명시했고, 이 문구는 외부 데이터 통합 자체까지 금지하는 것으로 넓게 읽혔다 — 로드맵과 정면 충돌. 결과적으로 거버넌스 상태가 엉켰다(029/036 reversed, 031 Phase 3/4 폐기, 039 write 경로 frozen-then-scoped).

owner의 재정의 원칙이 이를 푼다: **"read-only" 제약은 AWS 리소스 상태 + 자율 실행에 관한 것이지, DATA에 관한 것이 아니다.** 외부 관측성 read와 외부 기록/티켓/메시지 write는 DATA 연산이다 — AWS 리소스를 생성/수정/삭제하지 않으며 자율 AWS 행동이 아니다. 이것이 정확히 AWS 에이전트 모델이 하는 일이다.

AWSops is a read-only ops dashboard + AI-diagnosis product that also wants the AWS DevOps/Security/FinOps frontier-agent integration model (read external observability; write external records). Those goals only conflicted under a broad reading of "read-only." The owner's principle resolves it: "read-only" was always about AWS **resources** + autonomy, not about **DATA**. Reading external observability and writing external records/tickets/messages are DATA operations, not AWS-resource mutations — exactly the AWS agent model.

## Decision / 결정

**read-only 자세는 AWS 리소스 상태 + 자율에 적용되며, 외부 DATA에는 적용되지 않는다.**

### 1. FROZEN — 진짜 read-only 제약 (불변) / the real read-only constraint, unchanged

AWS 리소스의 생성/수정/삭제(SSM Automation, Change Manager, 인프라 변경, IaC apply)와 **자율 행동**(human-approval 없는 AWS 리소스 조작)은 영구 동결(do-not-enable). 029/036은 AWS 리소스 스코프에 한해 reversed 유지; 032 자율 mitigation은 frozen 유지. (이 동결의 권위 근거는 2026-06-11 3-AI 합의 — `docs/history/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`.)

### 2. PERMITTED under governance — 외부 DATA 통합 (1급) / external DATA integration, first-class

- **외부 DATA READ** — 관측성/지식(Prometheus/Loki/Tempo/ClickHouse/Grafana/Datadog, wiki). 이미 **LIVE**. 단일 MCP egress substrate(`agent.py` 라이브 MCP) 위에서 동작하며, 011의 BFF 라우트(`/api/datasources`)+`data/config.json` 메커니즘이 아니라 Secrets Manager ARN-ref + 런타임 fetch + 계정별 스코핑으로 자격증명을 다룬다.
- **외부 DATA WRITE** — 기록/업무/커뮤니케이션(Notion/Confluence 페이지, Jira/ServiceNow 티켓, Slack 메시지). 외부 시스템에 *기록/메시지*를 쓰는 것은 DATA 연산이지 AWS 리소스 변경이 아니므로 read-only 제약 대상이 아니다. 거버넌스(아래 §6 Pillars) 하에 허용. 모델은 *입력을 제안만* 하고 직접 쓰지 않는다.

### 3. 2-티어 write 명시 (현실 정합) / two-tier external write — explicit

외부 DATA write 티어는 일률 OFF가 아니다. 두 티어로 명확히 구분한다:

| 티어 | 범위 | flag | 상태 (2026-06-21 감사 §D) |
|---|---|---|---|
| **단일-토픽 통지** | SNS 이메일 통지, IAM이 단일 토픽으로 스코프된 외부-comms write | `diagnosis_notify_enabled` | **이미 LIVE** (ON) — AWS 리소스 변경 아님 |
| **광역 거버넌스 write** | Slack/Notion/Jira 등 임의 SaaS 기록·티켓·메시지 | `integrations_write_enabled` | **GATED OFF** (default false, 코드 flag-OFF 출하) |

또한 관련 GATED 항목: `datasource_diagnosis_enabled`(거버넌스된 egress collector)는 **GATED**, `integrations_enabled` + `{prometheus,loki,tempo,mimir,clickhouse}_vpc_enabled`(read substrate)는 **LIVE**.

→ 즉 "외부 데이터 write가 영구 동결"이 아니라, **저-blast-radius 단일-토픽 통지는 LIVE / 광역 임의-SaaS write는 거버넌스 하 GATED-OFF(owner가 켬)**.

### 4. 2026-06-11 'external-endpoint' 우려 = 금지가 아니라 통제 mandate / re-interpreted as a controls mandate

egress/SSRF/credential-custody/exfiltration 리스크는 **실재**하며, 데이터 통합을 금지하는 것이 아니라 의무 통제로 해소한다(아래 §6). 본 keystone은 011의 SSRF 방어를 그대로 승계한다(connection-time SSRF: https + DNS resolve-and-recheck + metadata/private block + `redirect:'manual'`). **2026-07-22 펜테스트(Finding 2/7) 대응으로 datasource-connector substrate(`agent/lambda/datasource_http.py` — ClickHouse/Prometheus/Loki/Tempo/Mimir/Jaeger/Dynatrace/Datadog)는 IP-pinning 적용 완료**: `assert_host_allowed()`가 검증한 IP를 캐시해 `http_json()`이 그 IP로 직접 접속(Host/SNI는 원본 호스트명 유지) — resolve-and-recheck 창을 제거. **잔존 backlog**: `agent.py`의 범용 egress-integrations 경로(`_assert_host_allowed`, ADR-039 direction=egress — Slack/Notion/Jira 등)는 여전히 resolve-and-recheck이며 별도 수정 필요(같은 취약군, 다른 전송 경로).

> **각주 — datasource-connector *read* substrate는 별도 스코프.** 위 SSRF 방어 문단과 §6.1 pillar 1은 `agent.py`의 **egress-READ** integrations 경로(`_assert_host_allowed`, ADR-039 MCP egress — Slack/Notion 등 커넥터의 read 세션)를 기술한다; §3의 "광역 거버넌스 **write**" 통제(`integrations_write_enabled`)는 실제 write 시 §5의 별도 **lambda executor 분기**(`executor_type='lambda'`)를 거치며 이 SSRF 가드를 거치지 않는다. 그와 또 다른 스코프인 `agent/lambda/datasource_http.py`(§2 "외부 DATA READ" — ClickHouse/Prometheus/Loki/Tempo/Mimir/Jaeger/Dynatrace/Datadog)의 `assert_host_allowed()`는: (a) **http와 https 둘 다 허용**(§6.1의 https-only 강제 없음 — in-cluster 관측성 엔드포인트가 평문 HTTP인 경우가 흔함), (b) private/RFC1918/ULA를 **무조건 허용**(계정별 `allow_private` opt-in 게이트가 코드에 없음 — 해당 substrate 자체가 in-cluster 대상이므로 opt-in 불필요로 설계됨), (c) 위 IP-pinning 적용. 이 substrate가 §6.1의 "private CIDR은 계정별 opt-in" pillar를 만족한다고 오독하지 말 것 — read substrate는 그 opt-in 메커니즘 자체가 없다. 이는 §5의 "단일 egress substrate" 원칙과 충돌하지 않는다 — `datasource_http.py`는 §5가 말하는 general-purpose(다목적) substrate가 아니라, 큐레이션된 관측성 커넥터 전용의 read-only 하위 transport다.

### 5. BYO-MCP / 임의 HTTP = 폐기, 큐레이션 커넥터만 / curated connectors only

임의 writable BYO-MCP(031 Phase 3의 uncurated 형태)는 폐기 유지. admin이 등록한 큐레이션·타입드 first-party 커넥터(벤더 프리셋)만 허용. egress substrate는 단일(011→039 재유도)이며, 별도 두 번째 substrate를 세우지 않는다. write 경로는 lambda executor 분기로 분리되며 AWS 리소스 SSM/Change-Manager 자동화를 부활시키지 않는다.

### 재정합 매핑 / Re-scope mapping

| 구 ADR | 2026-06-11 이전 | 본 keystone(007) 하 |
|---|---|---|
| 029 / 036 (mutating substrate) | REVERSED (전부) | AWS-리소스 변경은 reversed 유지; action_catalog/4-eyes/kill-switch facade는 외부 DATA write에 재사용 가능(별도 게이팅 층, 별도 엔진 아님) |
| 031 P3 (BYO-MCP) | 폐기 | 큐레이션 외부 DATA 커넥터(read/write) 허용; 임의/uncurated/writable BYO-MCP은 폐기 유지 |
| 031 P4 (mutating tools) | 폐기 | 외부 DATA-write 도구 허용; AWS-리소스 변경 도구는 frozen 유지 |
| 032 (autonomous incident) | DOWNGRADED | read-only 조사/Triage/RCA 유지; 자율 AWS-리소스 mitigation frozen |
| 039 (Integrations 축) | write 경로 frozen | DATA read+write 전면 in-scope; 039=substrate, 040(=본 §6)=write 통제 |
| 040 (외부 comms/knowledge write) | "좁은 예외/해제" | 재구성: '예외'가 아니라 데이터-write **표준 거버넌스** |

## Consequences / 결과

### Positive / 긍정
- **단일 정합 자세** — 엉킨 상태를 정리: *리소스 변경/자율 = 동결; 데이터 통합 = 거버넌스-개방*.
- AWS-agent-parity 통합 기능(DevOps/FinOps/Security 에이전트의 외부 데이터 시스템 read+write) 차단 해제.
- 미래 커넥터 판단 기준 명확화: "AWS 리소스를 바꾸거나 자율 행동하는가? → 동결. 외부 DATA를 read/write하는가? → 통제 하 허용."
- 이미 구축된 §6 substrate(action_catalog + dry-run + 4-eyes + rollback + kill-switch) 재사용 — 신규 엔진 없음.

### Negative / 부정 (리스크 — 정직)
- **데이터 유출 채널이 실재**: 프롬프트-인젝션된 에이전트가 내부 데이터(인벤토리/토폴로지/시크릿)를 외부로 게시 시도 → §6의 DLP/redaction + 목적지 allowlist + size cap + audit로 봉쇄. read-only 제품에 없던 **영구적·non-trivial 표면**. 통제가 실무에서 불충분하면 → draft-only 폴백 또는 re-freeze.
- **§6 통제 재활성화 = 029/036을 스코프된 형태로 재활성화** — slippery slope; 비-AWS-리소스 한정 + decoupled executor + flag 게이트로 완화.
- 소규모 팀의 데이터-write 통제(egress/자격증명 custody/승인/rollback 정합성) 유지 부담 — 의식적으로 수용; flag-OFF 출하, owner가 켬.
- 순수 통지에 한해 ADR-012 대비 한계 가치 — 증분 가치는 티켓/기록 생성이지 통지가 아님(통지는 단일-토픽 티어가 소유).

## 6 Pillars / 6대 거버넌스 기둥

외부 DATA write가 켜질 때 반드시 통과해야 하는 통제. (비-AWS-comms write에 맞게 의미 재매핑 — 멱등·가역 AWS-리소스 연산용으로 설계된 통제를 문자 그대로가 아니라 의미 보존하여 적용.)

1. **SSRF (연결 시점)** — **https-only**(egress-**READ** integrations 경로, `agent.py` `_assert_host_allowed`가 강제 — scheme≠https는 즉시 SsrfBlocked; ADR-039 MCP egress — Slack/Notion 등 실제 **write**는 이 경로를 거치지 않고 §5의 lambda executor 분기가 담당) + DNS resolve-and-recheck + metadata/private-CIDR block + `redirect:'manual'`. private CIDR은 계정별 opt-in. (011 승계, LIVE.) `agent.py`의 이 범용 egress-READ 경로는 resolve-and-recheck 잔존(backlog) — 아래 §4의 datasource-connector read substrate 각주 참조(또 다른 스코프, 이 pillar와 안 섞임).
2. **Secrets / credential custody** — 자격증명은 Secrets Manager(ARN-ref, 런타임 fetch, 계정별 스코핑). `data/config.json` 평문 저장 금지. GET 응답은 토큰 마스킹.
3. **DLP / redaction (반대표의 결정적 지점)** — 모든 write payload는 server-side egress DLP 통과: 시크릿/자격증명 금지, raw 인벤토리/토폴로지/계정 덤프 금지, per-connector 목적지 allowlist(admin 등록 SaaS 타깃만), content-size cap, audit. 신뢰성 있게 redact 불가능한 커넥터 → **draft-only**(에이전트가 본문 렌더, 사람이 copy-paste; egress-write 표면 0).
4. **human-gate (4-eyes + dry-run + rollback)** — action_catalog facade(`executor_type='lambda'`), `enabled=false` default, 필수 dry-run(=draft-render, SaaS엔 dry-run API 없으므로 DLP-후 payload를 사람 검토용 렌더), 4-eyes(승인자≠생성자) 또는 로그된 single-operator escape, paired rollback_ref(보상 행동 + audit, 진짜 undo로 표기 금지 — 이미 읽힌 알림은 비가역), idempotency token(`job_id`-keyed dedup). 모델은 입력 제안만.
5. **flag (fail-closed)** — 단계적·flag-게이트·owner-enabled. 광역 write는 `integrations_write_enabled`(default false, $0/dark), 전용 kill-switch, no-AWS-mutation IAM role로 출하. 두 개의 완전 독립 컨트롤 플레인(자체 flag env / kill-switch / IAM). owner가 flag + action `enabled=true` + 목적지 allowlist를 명시적으로 켜야 활성.
6. **curation / audit** — 큐레이션·admin-등록·타입드 first-party 커넥터만(임의 BYO-MCP 폐기). 등록(egress/자격증명)=admin; 폼 작성=일반 사용자(per-account `nonAdminAuthoring` default-OFF); zip 업로드·enable=admin. 모든 write는 Aurora + S3 Object-Lock 감사 기록.

> **개정 (2026-07-31, ADR-017):** §5("큐레이션 커넥터만")와 §6("모든 write payload는 server-side DLP/redaction·human-gate 통과")는 `mcp.lambda` target(자체 Lambda 핸들러)을 전제로 서술됐다. ADR-017이 도입한 `mcpServer`-type target(원격 벤더 MCP 프리셋)은 **같은 기술적 공백**을 갖는다 — provision.py에 `tools/list` 동등 control-plane API가 없어 벤더가 광고하는 툴 목록을 **읽을 수조차 없고**, 툴 집합을 고정할 수 있는 유일한 필드 `McpServerTargetConfiguration.mcpToolSchema`는 authorization code grant 전용이라 API_KEY 프리셋에는 쓸 수 없다. 따라서 서버측 DLP/redaction/human-gate를 그 원격 target 앞에 강제로 끼워넣을 지점이 없다.
>
> **명확히 기록한다 — `capability = read`는 이 경로에서 선언적 라벨이며 강제되지 않는다.** 벤더가 이미 ack된 프리셋에 write 툴을 추가하면 다음 `make agentcore`에서 재-ack·PR·리뷰 없이 에이전트 툴 surface에 편입된다. 즉 "이 예외는 write 경로를 열지 않는다"고 단정할 수 없으며, AgentCore가 API_KEY 경로에 툴 스키마 상한을 제공하지 않는 것은 사실이지만 이것은 **수용된 잔여 리스크가 아니라 활성화 차단 사유**다 — BASELINE §1 은 외부 DATA write 를 거버넌스 하에서만 허용하고 ADR 이 그 요건을 단독 면제할 수 없으므로, `official_mcp_enabled` 는 런타임 per-preset 툴 allowlist(agent.py:get_all_tools)가 생길 때까지 do-not-enable 이다(ADR-017 §Status). §5의 "큐레이션 = 기술적으로 강제된 provenance 보증" 프레임도 이 경로에서는 성립하지 않는다 — "큐레이션"의 실제 의미는 `preset_key`(우리가 카탈로그에 등록한 벤더만 존재) + `official_mcp_read_only_ack`(운영자 attestation)이며, 엔드포인트 호스트는 **코드로 고정된다** — 벤더 호스팅은 카탈로그 `allowed_host_suffixes`(파싱된 hostname 의 DNS 라벨 경계 매칭), 자체 호스팅은 in-VPC 사설 IP 리터럴, 둘 다 없는 카탈로그 항목은 fail-closed (ADR-017 §Trade-offs ②, `provision.py::_host_pin_violation`).
>
> 실제로 존재하는 보상 컨트롤: `official_mcp_enabled`·`integrations_enabled` 기본 false, 큐레이션 카탈로그(임의 URL 등록 UI 없음 — `custom_mcp` 폐기 유지), 프리셋별 fail-closed `official_mcp_read_only_ack`, `integrations_write_enabled`(§6 write 게이트)가 이 기능과 독립적으로 계속 기본 false. §6의 DLP/human-gate 요구사항 자체는 (아직 켜지지 않은) 광역 write 티어에 계속 full로 적용되며 이 예외로 약화되지 않는다. 상세는 ADR-017 §Trade-offs·§Security, ADR-004 위 개정(같은 기술적 공백 + managed-egress SSRF 한계) 참조.
>
> **Amendment (2026-07-31, ADR-017):** §5 ("curated connectors only") and §6 ("every write payload passes server-side DLP/redaction + human-gate") were both written assuming `mcp.lambda` targets (our own Lambda handler). The `mcpServer`-type targets (remote vendor MCP presets) ADR-017 introduces have the **same technical gap**: provision.py has no `tools/list`-equivalent control-plane API and therefore cannot even READ what the vendor's server advertises, and the one field that would cap the tool set, `McpServerTargetConfiguration.mcpToolSchema`, requires an authorization-code-grant credential and is unavailable to these API_KEY presets. There is consequently no point at which server-side DLP/redaction/human-gate could be inserted in front of that remote target.
>
> **Stated plainly: `capability = read` is a declarative label on this path, not something enforced.** If a vendor adds a write tool to an already-acked preset, it enters the agent's tool surface on the next `make agentcore` with no re-ack, no PR and no review. The claim "this exception never opens a write path" therefore does not hold, and the gap is a **knowingly accepted residual risk** — AgentCore provides no tool-schema cap on the API_KEY path. §5's framing of curation as a technically-enforced provenance guarantee also does not hold here: "curation" concretely means `preset_key` (only vendors we put in the catalog exist) + `official_mcp_read_only_ack` (operator attestation), and the endpoint host itself is operator-asserted rather than code-pinned (ADR-017 §Trade-offs risk ②).
>
> Compensating controls that actually exist: `official_mcp_enabled` / `integrations_enabled` default-off; the curated catalog (no arbitrary-URL registration UI — `custom_mcp` stays retired); the fail-closed per-preset `official_mcp_read_only_ack`; and `integrations_write_enabled` (§6's write gate) remaining independently default-false. §6's DLP/human-gate requirement itself still applies in full to the (not-yet-enabled) broad write tier and is not weakened by this exception. See ADR-017 §Trade-offs/§Security and the ADR-004 amendment above (same technical gap, plus the managed-egress SSRF limitation).
>
> **Follow-up (2026-08-05, ADR-017 재개정 — anti-drift 정합화 / anti-drift reconciliation):** the "knowingly accepted residual risk" this amendment describes (a vendor adding a write tool to an already-acked preset, absorbed with no re-ack) is **resolved** by ADR-017's 2026-08-05 re-amendment for the 3 remaining vendor-hosted presets (Datadog/Dynatrace/New Relic — the 5 self-hosted presets this amendment also worried about are removed from the catalog entirely): a runtime fail-closed tool allowlist (`OFFICIAL_MCP_TOOL_ALLOWLIST_JSON` → intersected in `agent.py`, empty/unset ⇒ zero tools) now enforces `capability=read` in code, not just as a declarative label — so `official_mcp_enabled` is ordinary GATED (BASELINE §2). The DLP/human-gate/curation framing this amendment corrects otherwise still stands. ClickHouse's stdio embedding (`CLICKHOUSE_OFFICIAL_MCP`) is an unrelated mechanism and remains separately do-not-enable/FROZEN for a different reason (it drops the in-house lambda's SSRF/read-only defenses with no replacement — ADR-017 §Trade-offs, BASELINE §2).

---

**핵심 / Bottom line:** read-only 제약 = **AWS-리소스 변경 + 자율**에 한정(SSM/infra/autonomous = 영구 동결, do-not-enable). 외부 *DATA*는 아님 — 외부 관측성 read는 LIVE, 외부 기록/메시지 write는 6대 기둥(SSRF·Secrets·DLP/redaction·human-gate·flag·curation) 하 허용. 2-티어: `diagnosis_notify`(단일 토픽)=LIVE / 광역 `integrations_write_enabled`(Slack/Notion/Jira)=GATED-OFF. 임의 BYO-MCP=폐기, 큐레이션 커넥터만.

## References / 참고
- Consolidates: 011, 031(P3: BYO-MCP → 큐레이션 커넥터만), 039, 040, 041. (옛 본문: `git show adr-legacy-2026-06-22:docs/decisions/0NN-*.md`)
- 리소스 변경·자율 동결 권위: `docs/history/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`.
- 외부 write 비준 패널: `docs/history/reviews/2026-06-14-external-write-unfreeze-consensus.md`.
- 현실 감사(2-티어 flag 상태): `docs/reviews/2026-06-21-docs-reality-audit.md` §D.
- 동반 스펙: `docs/history/specs/2026-06-12-custom-agent-platform-design.md`.
