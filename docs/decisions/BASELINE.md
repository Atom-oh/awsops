# AWSops 결정 베이스라인 (BASELINE) / Decision Baseline

> **이것이 결정의 단일 현행 진실(single source of truth)이다.** AI·사람 모두 여기부터 읽는다. 상세 근거는 같은 디렉토리의 통합 ADR(`0NN-*.md`)을, 옛 이력은 `../history/`를 본다(명시 요청 없이는 읽지 않는다).
> 범위 = **v2 현행 진실.** v1(CDK/EC2/Steampipe, `/awsops` basePath)은 **폐기 진행 중**(ADR-016, 2026-07-09 결정) — Phase 5(repo 코드 정리) 완료(2026-07-12, `src/`/`infra-cdk/` 등 제거), Phase 4.1~4.3(CFN 스택 삭제, ALB/SQS) 완료(2026-08-25), **Phase 4.4/4.5(고아 Lambda·AgentCore 게이트웨이/Memory/Interpreter·배포 버킷)는 2026-08-27부로 미확정**(원래 19개 Lambda 목록에서 2개 누락이 발견되어 21개 목록으로 재실행 필요 — `docs/runbooks/v1-decommission.md` §Phase 4 참조)(§1 범위 참조).
> This is the single current-truth for decisions. Read this first; ADRs (`0NN-*.md`) hold detail, `../history/` holds the frozen past.

---

## §0 북극성 (North Star) — 고정 (변경 시 owner 승인)

### 목표 (Goal)
> **AWSops는 AWS에 올라가는 모든 리소스를 AWS Well-Architected 6대 기둥에 맞게 안전하고 빠르게 운영하도록 돕는다.**
> 6대 기둥: 운영 우수성 · 보안 · 안정성 · 성능 효율성 · 비용 최적화 · 지속가능성.
> 다양한 데이터소스와 에이전트로 **6대 기둥 관점의 진단과 해결방법 제시**를 제공하여 운영을 지속 고도화한다.

"안전하게"는 목표의 일부다. read-only 자세는 후퇴가 아니라 **안전을 위한 실행 경로 게이팅**이다.

### 가치 (Value)
- **단일 창에서 6대 기둥을 본다** — 인벤토리·토폴로지(안정성), 비용(비용최적화), 보안/CIS(보안), 메트릭(성능), 진단(운영우수성).
- **진단을 넘어 해결까지** — 라이브 데이터(AWS + 외부 관측성) + 에이전트로 근본원인 + *고치는 법*까지 제시.
- **안전 내장** — 빠르게 운영하되 위험한 실행은 통제·게이트·승인 뒤. 프로덕션에 붙여도 안전.

### 핵심 설계 (Core Design) — 4축
1. 모든 기능·진단은 **6대 기둥 중 하나 이상에 매핑**된다 (새 결정의 정당성 = 어느 기둥을 개선하나).
2. 운영의 현재 형태 = **진단 + 해결방법 제시**. 실행은 안전 게이트 뒤.
3. **Terraform MSA** — 비공개 엣지(CloudFront VPC Origin → 내부 ALB → Fargate) · Aurora 영속 상태 · thin-BFF + 비동기 워커 · AgentCore 섹션 에이전트 · 외부 데이터소스/통합.
4. **모든 신기능 flag-gated** — 기본 OFF, 안전하게 단계적 활성화.

### 실행/자동화의 위상 (점진적 실행, 단 현 invariant 유지)
- 최종 목표(aspiration)는 안전한 *실행/자동화*까지 포함한다 — 이는 §0 방향으로 보존한다.
- **현재 ON = 진단 + 해결방법 제시(read-only).**
- AWS 리소스 변경·자율 조치는 **FROZEN**(§2). "영구 금지"가 아니라 "안전조건+명시적 새 결정 전까지 동결" — 단 **이 문서/리셋으로 풀지 않는다.** 완화는 새 ADR + 멀티-AI 패널 + 날짜박힌 owner-override가 필요한 별도 제품 결정이다. (2026-06-11 reversal을 조용히 재해석 금지.)
- aspiration(나아간다)과 오늘의 FROZEN invariant는 양립한다.

---

## §1 불변식 / 용어 (Invariants) — 결정론적 판정 기준

- **read-only의 정의** = **AWS 리소스 변경 금지 + 자율 조치 금지**(SSM/인프라/autonomous mutation = §2 FROZEN). 외부 *DATA* read/write는 read-only 제약 대상이 **아니다** — 거버넌스(SSRF·Secrets·DLP·human-gate·flag) 하에 허용(→ ADR-007).
- **6기둥 매핑 규칙** — 모든 신규 기능/결정은 WA 6기둥 중 최소 하나를 개선해야 한다. PR/ADR은 어느 기둥인지 명시한다.
- **flag 규율** — 위험·대형 기능은 `*_enabled` count/flag 게이트(기본 false → `plan`=무변경·$0). FROZEN 항목은 default false 유지가 invariant(§2).
- **BASELINE 크기 예산** — 이 문서는 *index*이지 소설이 아니다. 상세 설계는 `../reference/`로, 결정 근거는 통합 ADR로, 옛 이력은 `../history/`로 위임한다. §3 줄 수가 늘면 토픽 통합/reference 추출.
- **범위 = v2.** v1은 **ADR-016에 따라 단계적 폐기 진행 중**(Phase 0~5, `docs/runbooks/v1-decommission.md`) — **Phase 5(repo `src/`/`infra-cdk/` 등 코드 정리) 완료(2026-07-12)**, **Phase 4.1~4.3(CFN 스택 `AwsopsStack` 삭제, ALB/SQS) 완료(2026-08-25)**, **Phase 4.4/4.5(고아 Lambda 21개·AgentCore 게이트웨이 8개/Memory/Code Interpreter·배포 버킷)는 2026-08-27부로 미확정** — 2026-08-25 실행이 쓴 19개 Lambda 목록에서 `awsops-istio-mcp`/`awsops-datasource-diag-mcp` 2개가 빠져 있었음이 확인되어, 21개로 정정된 목록으로 `scripts/v2/teardown/v1-teardown-4.4-4.5.sh` 재실행이 완료돼야 Phase 4가 확정된다(ADR-016 §Phase 4 실행 기록, `docs/runbooks/v1-decommission.md` §Phase 4 참조). Phase 4.4/4.5 확정 전까지 v1 AWS 인프라(EC2/CloudFront는 이미 stop/disable) 관련 논의는 이 BASELINE의 "현행 진실 위반"이 아니다.
- **anti-drift(C2)** — 새 ADR/flag 변경은 **같은 PR에서 §3(또는 §2) 갱신**이 필수다. 갱신 없으면 "not live". 옛 ADR 본문은 트리에 없다(git tag `adr-legacy-2026-06-22` 보존, 매핑 `../history/ADR-MAPPING.md`).

---

## §2 게이트 / 동결 register (Gated / Frozen)

> 2-티어: **FROZEN**(do-not-enable, 풀려면 새 ADR+패널+owner-override) vs **GATED**(거버넌스 하 활성화 가능, 현재 OFF). 아래 **feature gate** 는 default=false 와 일치한다 — 대부분 terraform flag이고, `CLICKHOUSE_OFFICIAL_MCP`·`ANTHROPIC_AGENT_LOOP_ENABLED` 두 건은 provisioner가 기록하는 **AgentCore 런타임 env** 다(게이트 종류가 다를 뿐 default-off invariant는 동일하게 적용). 예외로 아래 **마이그레이션 창 스위치**(`legacy_email_owner_match`) 행은 기본 **true** 다 — 기능을 켜는 플래그가 아니라 이관이 끝날 때까지 legacy 동작을 유지하는 스위치이므로, 기본값이 반대다.
>
> **"코드에 머지" ≠ "라이브에 적용"(anti-drift, 2026-08-11 사고 기록):** `legacy_email_owner_match` 행의 `account_recovery_setting=admin_only`는 PR #203(2026-08-04 머지)에서 "이 PR에서 닫았다"고 서술됐지만, 그 apply가 실제 라이브 계정 180294183052에 반영된 것은 **2026-08-11**이었다(그 사이 tfstate가 7/23에 멈춰 있었음 — 22개 커밋분 미적용). 이 문서의 서술 시점과 실제 적용 시점이 다를 수 있다는 뜻이다. 아래 **라이브(2026-08-11 확인)** 열은 그 사고를 계기로 추가했다 — 코드/문서가 뭐라 말하든, 이 열은 실제 조회로 확인한 상태만 기록한다. 이후 값이 바뀌면 이 열도 갱신하고 확인 날짜를 갈아 끼운다(스냅샷이며 실시간 아님).

| 상태 | 항목 | flag | 라이브(2026-08-11 확인) | 켜는 조건 / 비고 | 근거 ADR |
|---|---|---|---|---|---|
| **FROZEN** | AWS 리소스 변경(SSM/Change Manager) + 자율 mitigation substrate | `remediation_enabled` | OFF | **do-not-enable.** 재활성화 = 새 ADR로 2026-06-11 reversal 명시 번복 + 멀티-AI 패널 + owner-override. flag-OFF substrate는 보존(삭제 아님) | ADR-005 |
| **마이그레이션 창** (feature gate 아님) | legacy email-keyed 소유권 매칭을 수용(읽기 + report PATCH/DELETE — `matchesIdentity()` 를 거치는 모든 게이트) | `legacy_email_owner_match` — **기본 true** | ON (ECS taskdef env) | 이관 스위치. `make` target 은 **plan-only** 이므로 clean plan 만으로는 조건이 아니다 — clean plan 은 아직 아무 행도 rewrite 되지 않은 상태에서도 성립한다. **`--apply` 가 성공하고 잔여 legacy email-keyed row 가 0 임을 확인한 뒤에만** `false` 로 내린다(애초에 legacy 행이 없어 plan 이 zero-row 로 끝난 경우도 이 조건을 만족한다 — 재작성할 것이 없었으므로). 그전에 내리면 legacy 행이 소유자에게 안 보인다. 켜져 있는 동안은 재할당된 주소가 전 소유자의 legacy 행과 일치할 수 있다. 세 경로 중 **둘만** 닫혔다: 기존 계정의 email *변경*은 `write_attributes` 축소로, *신규* 계정 signup 은 `allow_admin_create_user_only` 로. **세 번째는 계정 복구였고 PR #203(2026-08-04 머지)에서 닫았다**(라이브 반영은 2026-08-11 — 위 anti-drift 기록 참조) — public `ForgotPassword` 는 그 주소로 코드를 보내므로 mailbox 보유자가 기존 계정을 인수할 수 있었다(그 경우 legacy 행뿐 아니라 sub-keyed 행까지 넘어간다). `account_recovery_setting = admin_only` 로 self-service 복구 자체를 제거했다 — 대가는 비밀번호 재설정이 운영자 작업이 되는 것이고, 이 pool 은 이미 admin-create-only 라 그 모델과 일치한다. 오프보딩(`docs/runbooks/user-offboarding.md`)은 여전히 필요하다(세션·admin allowlist·스케줄 정리). ADR-002 참조 — **`account_recovery_setting=admin_only` 자체는 라이브에 2026-08-11에야 반영됨(위 anti-drift 기록 참조)** | ADR-009 |
| **GATED** | 자율 인시던트 라이프사이클 | `incident_lifecycle_enabled` | OFF | analysis-only(read-only triage/RCA, 권고전용, mutation 라우팅 금지). 활성화해도 자율 조치 없음 | ADR-006 |
| **GATED** | RCA write-back (OpsCenter/Incident Manager 관측메타 write) | `rca_writeback_enabled` | OFF | `incident_lifecycle_enabled` + **자족 role 분리 선행**(현재 frozen remediation role 상속 → 분리 전 do-not-enable) | ADR-006 |
| **GATED** | K8sGPT 인클러스터 진단 | `k8sgpt_enabled` | OFF | GET-only(Result CRD read), 클러스터 write 없음, 오퍼레이터는 out-of-band 설치 | ADR-006 |
| **LIVE** (외부 write 중 유일) | 진단 완료 SNS 이메일 통지 | `diagnosis_notify_enabled` | ON | **이미 켜져 있음** — IAM 단일 토픽 스코프, AWS-리소스 변경 아님(거버넌스 충족 — 아래 "주의" blockquote 참조) + 관리자 전용 테스트 발송(web 태스크, 동일 토픽 한정 sns:Publish — 2026-08-31) + 런타임 일시중지 토글(app_settings `diagnosis_notify_paused`, 관리자 전용, 중지=탈락/재발송 없음, 조회 실패 fail-open) + 내구 배달 레코드(diagnosis_reports.notify_outcome — MessageId 확인 시에만 emailed, publish_failed는 drain 후 미재시도 — 2026-09-01) | ADR-013 |
| **GATED(거버넌스)** | 외부 knowledge/comms write — 광역(Slack/Notion/Jira) | `integrations_write_enabled` | OFF | 독립 control plane · no-AWS-mutation IAM · SSRF/Secrets/DLP/human-gate. BYO-MCP(임의) 제외, 큐레이션 커넥터만 | ADR-007 |
| **GATED** | 외부 관측성 진단 수집 | `datasource_diagnosis_enabled` | OFF | governed egress collector(read), SSRF 방어 | ADR-007/ADR-008 |
| **GATED** | 그래프 쿼리 LLM 폴백 (ClickHouse trace_spans 1건) | `graph_querygen_enabled` | OFF | `datasource_diagnosis_enabled` 선행. ClickHouse 스키마가 표준 OTel shape 과 다를 때 Bedrock(Haiku)이 **그래프 쿼리 1건**을 생성하고, static read-only 검사 + (선택) Code Interpreter + LIMIT 1 dry-run 을 모두 통과한 것만 캐시. 실행 경로는 read-only 커넥터 | ADR-018 |
| **GATED** | diag-signal LLM 폴백 (Explore 칩) | `diag_signal_querygen_enabled` | OFF | `datasource_diagnosis_enabled` 선행. **위 플래그와 분리**되어 있다 — "ClickHouse 그래프 쿼리 1건"에 대한 동의가 "fallback 대상 kind 전체에 매일 LLM 생성 + 라이브 dry-run"에 대한 동의는 아니다(PR #205 리뷰 MAJOR, 3개 렌즈 4모델). 결정론 매처가 **ready 0행**인 kind 에서만(부분 매칭 개선은 범위 밖) Bedrock 에 쿼리 1개를 요청하고, (a) static read-only 검사(+`SETTINGS` 절 거부) (b) **그 인스턴스 스키마 어휘 언급 + 상수 아님** (c) dry-run 응답이 error envelope 도 **빈 payload 도 아님**(상한: ClickHouse `max_execution_time=5`, Prom/Mimir `timeout=5s`, Loki/Tempo `limit=1`)을 모두 통과해야 캐시 — 존재하지 않는 메트릭이 `result: []` 를 돌려주면 ready 로 저장되지 않는다. **빈 응답의 분류만 REJECTED 가 아니라 TRANSIENT** 다: 조용한 시간대의 정상 datasource 를 영구 skip 시키지 않기 위해 주간 예산 안에서 재시도되고, 예산이 끝나면 그 주는 park 된다. 실패가 일시적이면 전용 예산 행 `__diag_signal_budget__` 의 `meta.budget` 마커(`<hash>:<pend\|done\|conc><attempts>w<주차>[s<streak>]` — 콘텐츠 행의 `schema_version`/콘텐츠 버전에는 절대 넣지 않는다)에 `pend` 로 기록해 다음 실행이 재시도(**인스턴스당 주 3회, 연속 3주 소진 시 스키마 변경까지 정지** — 마커는 주 안에서는 버전과 무관하게 읽어 스키마 churn 이 예산을 리셋하지 못한다. un-park 은 **주차 경계에서만** 일어나며, 그 시점에 스키마가 실제로 바뀌었으면 attempts/연속주차를 리셋 — 같은 주 안에서 스키마가 바뀌어도 주간 상한 자체는 갱신되지 않는다). **정산되면(ready 또는 플래그 OFF) `conc` 마커로 그 주에 이미 쓴 attempts 를 보존하면서, 주차가 바뀌어도 스키마 해시가 같은 동안 settled 유지** — 마커를 아예 안 쓰는 경우는 그 주에 쓴 attempts 도 streak 도 없는 경우뿐. 그래야 스키마 불변 시 매주 재생성이 재발하지 않는다. 생성 행은 Explore 칩 전용 — 진단 리포트 경로에서 제외되고, **플래그 OFF 면 BFF read path 에서도 제외**(워커가 안 돌면 sweep 도 없으므로) | ADR-018 |
| **GATED(실험)** | 챗 에이전트 루프 — `AsyncAnthropicBedrock` 커스텀 루프(다크) | `ANTHROPIC_AGENT_LOOP_ENABLED` (+ per-request `payload.agentLoop` 오버라이드) | OFF (런타임 env) | default OFF·dark. read-only·additive; Bedrock 경유(IAM/VPC/레지던시/비용귀속 보존, API키 無, 동일 global.* 프로파일+홈리전), 기존 게이트웨이 MCP 재사용(BYO-MCP 아님). 레버=도구 루프 디버깅성(지연 아님). **per-request `payload.agentLoop`('anthropic'\|'strands')가 env를 오버라이드** — BFF는 client-controlled `agentLoop`를 forward하지 않음(서버측 설정만; 불변식 유지 필수) | ADR-008/ADR-003 |
| **GATED(owner-override 예외)** | 운영 자가치유: 호스트 자기 서비스 재배포(Aurora secret 회전 복구) | `secret_rotation_redeploy_enabled` | OFF | **ADR-005 freeze에 대한 명시적·날짜박힌 owner-override 예외**(오준석, 2026-07-01, PR #114 멀티-AI 패널 리뷰 거쳐 ratify — self-scoping 재해석이 아님). EventBridge(RotationSucceeded)→Lambda→`ecs:UpdateService` force-new-deployment **자기 web 서비스 한정**. IAM 1 ARN·secret-id fail-closed·default-off. ADR-005의 나머지(remediation/BYO-MCP/mutating tools)는 그대로 FROZEN — 이 예외는 이 좁은 케이스 하나만. CloudTrail trail 의존 | ADR-015 |
| **GATED** | 큐레이션 공식 MCP 프리셋 (external-obs `mcpServer` target) | `official_mcp_enabled` | OFF (엔드포인트 0건) | **벤더 호스팅 3종만**(Datadog·Dynatrace·New Relic — 2026-08-05 개정으로 자체 호스팅 clickhouse/tempo/jaeger/grafana/splunk 프리셋 제거). 엔드포인트는 `official_mcp_endpoints` map(데이터, https만, `allowed_host_suffixes` 핀), capability=read. 강제 2중: ① 프리셋별 `official_mcp_read_only_ack[preset_key]`(= 검토한 엔드포인트 URL, 미설정/불일치 ⇒ SKIP+retire), ② **런타임 fail-closed 툴 allowlist** — catalog `tool_allowlist`(벤더 문서 전사, 추측 금지) → `OFFICIAL_MCP_TOOL_ALLOWLIST_JSON` 런타임 env → agent.py가 `*-mcp-server-target___*` 툴을 교집합(공란 ⇒ 툴 0개, env 부재 ⇒ 전부 드랍). 종전 do-not-enable 사유 2건(allowlist 부재·자체호스팅 도달성)은 해소 — 일반 GATED. 운영 주의: provisioner는 런타임 READY 확인(기본 300s, `AGENTCORE_RUNTIME_READY_TIMEOUT`) 실패 시 자격을 갖춘 live target까지 회수한다(fail-closed — 구 런타임이 무필터 서빙하는 것 방지; 다음 성공 run이 멱등 재생성). Prometheus/Mimir(공식 MCP 無)·Tempo/Jaeger(인-바이너리)·Notion(hosted 3LO 전용)은 자체 람다/기존 방식 유지, Grafana/Splunk는 미지원. `custom_mcp`(임의 엔드포인트) 등록은 그대로 폐기 | ADR-017 |
| **FROZEN** | ClickHouse 공식 MCP stdio 내장 (AgentCore 런타임 내 `mcp-clickhouse` 서브프로세스) | `CLICKHOUSE_OFFICIAL_MCP` (런타임 env, `make agentcore` 시 기록) | OFF (런타임 env) | **do-not-enable(리뷰 2026-08-05, PR #207).** 기존 Datasources 등록(integrations secret `clickhouse` kind-mirror)의 endpoint/자격증명 재사용 — 신규 토큰·서버·terraform 없음. `CLICKHOUSE_ALLOW_WRITE_ACCESS=false`·`ALLOW_DROP=false` 코드 고정만 있고, 자체 람다 경로(`clickhouse_mcp.py`)의 1차 방어(테이블 함수 SSRF 차단 + ClickHouse `readonly=1` + connect-time host 가드)는 stdio 경로에 대체물이 없다 — 켜면 프롬프트-인젝션 경로로 in-VPC/메타데이터 SSRF 도달 가능. 재활성화 조건: stdio 앞단에 동등 쿼리 가드 또는 ClickHouse 서버측 최소권한 프로필. stdio 연결이 성공한 턴에만 자체 람다 clickhouse 툴을 런타임에서 드랍(상호배제 — 연결 실패 시 람다 유지) — 이 부분 로직은 유효, 방어 공백과는 별개 | ADR-017 |
| **LIVE(read-only 관찰)** | EKS out-of-band 온보딩 관찰(CloudTrail 구동, Access Entry 생성 반영) | `eks_auto_register_enabled` && `workers_enabled`(`eks.tf` 게이트 — 둘 다 필요, 하나만 켜면 관찰 경로가 조용히 꺼진다) | ON | 2026-08-11 라이브 조회로 확인(`docs/reference/07-eks.md` §Out-of-band 참조) — `onboard_eks_clusters`(tfvars) 밖에서 운영자가 CLI로 만든 Access Entry를 read-only Lambda(`awsops-v2-eks-auto-register`, `scripts/v2/eks/auto_register.py`)가 관찰해 Aurora `eks_registrations`에 반영, BFF allow-list = `ONBOARDED_EKS_CLUSTERS`(TF) ∪ `eks_registrations`(runtime). AWS 쓰기 없음(관찰만) — `eks.tf`가 이 Lambda에 부여하는 권한은 `secretsmanager:GetSecretValue`(Aurora secret)+`kms:Decrypt`+VPC exec뿐이고, `auto_register.py`는 연결된 정책이 `/AmazonEKSViewPolicy` 또는 `/AmazonEKSAdminViewPolicy`로 끝나지 않으면 등록을 거부한다. 전용 ADR 없음(신규 제품 결정이 아니라 이미 존재하는 P1e EKS 온보딩의 라이브 상태를 반영하는 anti-drift 기록) | — |
| **GATED** | FinOps 기본 권장 엔진(결정론적 룰 → `finops_findings`, LLM은 설명만) | `finops_baseline_enabled` | OFF | 일별 Fargate 배치, `/cost`는 Aurora만 읽음(요청 경로 라이브 AWS 호출 0). terraform 레벨로는 `workers_enabled`만 requires(Compute Optimizer 권한만 워커 task 롤에 직접 부여 — `agentcore_enabled` 무관. CE/COH/Budgets 룰은 카탈로그 등록만, 이번 버전은 미호출) — 단 EBS 룰은 런타임에 `steampipe_enabled=true`의 최신 `inventory_sync_runs` 행이 있어야 동작하고, 없으면 정직하게 `partial`로 표면화됨(EC2/RDS 두 룰은 무관하게 동작). read-only — AWS 리소스 변경 경로 없음(ADR-005 무관) | ADR-020 |
| **옵션(deferred)** | Neptune/그래프 substrate | — | N/A | Postgres-first 확정, 그래프 substrate는 후속 옵션 | legacy ADR-043 (deferred — MAPPING 참조) |
| **GATED** | Network Path Check — 저장 가능한 비동기 read-only 경로 정책 점검 (`network_path` job) | `network_path_check_enabled` | OFF | `workers_enabled` 선행. read-only 정적 분석만(SG/NACL/route/TGW/K8s policy/L7 describe) — Reachability Analyzer 생성·probe 실행 없음, `ec2:CreateNetworkInsightsPath`/`DeleteNetworkInsightsPath` 미부여. 워커 role에 `sts:AssumeRole`→`AWSopsReadOnlyRole` 최초 확장(기존 웹/Steampipe/agent 패턴 재사용, 신규 신뢰 관계 아님). **2026-08-25 상태 갱신(CI 리뷰 라운드 17)**: `scripts/v2/workers/network_path.py`의 `fetch_live_topology()`는 이제 실제 구현이다 — 캐시된 Aurora `topology_nodes`/`topology_edges`(`class='infra'`)로부터 best-effort 후보 경로를 탐색한다. 다만 실시간 AWS/Kubernetes API 재조회는 여전히 의도적으로 연결되지 않았다(설계 스펙이 원래 약속한 "SG/NACL/route 등을 run 시점에 실시간 재조회"는 아직 없음) — 그래서 `web/lib/network-path-gate.ts`의 `networkPathLiveTopologyCapabilityGate()`는 여전히 **신규 run 생성 자체를 거부**한다(503 `unimplemented`): `LIVE_TOPOLOGY_IMPLEMENTED`는 캐시-전용 가속기가 실제 구현된 지금도 의도적으로 `false`로 유지되며, 실시간 재조회 경로가 실제로 추가되는 커밋에서만 `true`로 전환한다. 기존 체크/정의와 과거 run 이력 조회는 계속 가능. 같은 라운드에서 Calico NetworkPolicy·Route 53·K8s Ingress→Service→EndpointSlice 평가기가 실 데이터 기반으로 구현됐고(Cilium/Istio는 여전히 스텁), `resolve_live_identity()`가 라이브 K8s/EC2 조회로 Pod/Node identity를 재확인하는 경로(Gap 4)도 추가됐다. **단측(source-side) 평가 구조적 한계**: `sg`/`nacl`/`route` 계층은 기본적으로 소스 ENI 쪽만 평가한다 — 목적지 쪽 자체 인바운드 SG/NACL·리턴 라우팅의 완전한 양방향 재작성은 이번 회차 범위 밖. 저비용 완화책만 적용: 목적지가 자체 describable ENI를 갖는 `aws_resource`인 경우(`dest_eni_known` 힌트) 동일한 `eval_security_group`/`eval_nacl` 어댑터를 `sg-dst`/`nacl-dst` 레이어로 재사용해 2차 패스를 추가 — 목적지 ENI를 알 수 없는 피어링/TGW/VPN/DX/ALB 프론트 목적지는 여전히 커버 안 됨(`network_path.py` 모듈 docstring 참조) | — |
| **GATED** | SG Rules & Usage — 일일 rule 인벤토리 + Athena 기반 90일 트래픽 증거 (`sg_rule_inventory`/`sg_rule_activity`/`sg_rule_source_validate` job) | `sg_rule_activity_enabled` | OFF | `workers_enabled` 선행. **역할 2개, 섞이지 않음(ADR-019 §4)**: (1) rule 인벤토리는 기존 `AWSopsReadOnlyRole` 재사용(웹/Steampipe/agent와 동일 패턴). (2) Athena 활동 파이프라인은 대상 계정의 **신규·격리된** `AWSopsSgRuleAthenaRole`을 assume — `AWSopsReadOnlyRole`은 건드리지 않으며, 공유 워커 task role은 이 role을 assume할 수 없다(전용 task role/definition 또는 broker Lambda로 격리, 구현 시 확정). Athena/Glue는 read/query 동사만(mutating 동사 없음); S3는 **서로 다른 두 위치를 절대 혼동하지 않음**(ADR-019 §Decision) — Flow Log 소스 위치는 `s3:GetObject`/`ListBucket`(read만), 워크그룹의 **결과** prefix는 `s3:GetObject`/`ListBucket`/`PutObject`/`AbortMultipartUpload`(read+write 둘 다 필요 — Athena 자신이 자기가 쓴 결과를 `GetQueryResults`·result reuse에 다시 읽음; 그 prefix 밖 write·모든 `s3:DeleteObject`는 금지). `sg_rule_activity_max_query_bytes`(기본 100 GiB)로 스캔 예산 제한 | ADR-019 |

> **주의 (2-티어 정밀):** 외부 DATA write 티어가 일률 OFF는 아니다 — `diagnosis_notify_enabled`(SNS 이메일, IAM 단일 토픽 스코프 — 관리자 전용 테스트 발송 포함[2026-08-31], NOT AWS-리소스 변경)는 **이미 LIVE**(거버넌스 충족). 광역 `integrations_write_enabled`만 OFF. (ADR-007/ADR-013)

> **폐기(do-not-revive):** BYO-MCP(임의 형태 외부 MCP, ADR 구 031-P3) — 큐레이션 커넥터만 허용. (ADR-007)


---

> **인벤토리 쿼터 격리 (ADR-021, 2026-08-31):** Phase 1의 전역 Steampipe limiter, sync backpressure, structured terminal state, `inventory_stale_after_minutes=30` freshness 공개는 저장소에 구현됐다. 이 변경을 수행한 에이전트는 apply를 실행하지 않았으며 controller의 실제 배포 상태는 별도 확인한다. **현재는 ops gateway의 제한된 Aurora `inventory-read-target`과 직접 domain inventory/configuration API target이 공존한다.** Phase 2가 domain-aware Aurora coverage를 확장하고 direct target을 retirement한다. Aurora-only는 아직 live가 아니며 ADR-005 FROZEN은 그대로다.
>
> **Inventory quota isolation (ADR-021, 2026-08-31):** Phase 1's global Steampipe limiter, sync backpressure, structured terminal state, and `inventory_stale_after_minutes=30` freshness disclosure are implemented in the repository. The agent making this change did not run apply; controller deployment status must be verified separately. **Current truth is coexistence: the ops gateway's limited Aurora `inventory-read-target` remains live alongside direct domain inventory/configuration API targets.** Phase 2 expands domain-aware Aurora coverage and retires direct targets. Aurora-only is not live, and ADR-005 FROZEN is unchanged.

## §3 결정 인덱스 (Decision Index)

> 통합 ADR 21개. 상세·근거는 각 ADR. (옛 46개 → `../history/ADR-MAPPING.md`, 본문은 git tag `adr-legacy-2026-06-22`.)

| ADR | 토픽 | 한 줄 | 6기둥 |
|---|---|---|---|
| [001](001-v2-foundation.md) | v2 파운데이션 | Terraform MSA·비공개 엣지·Aurora·thin-BFF·이중 ECR (CDK·라이브 Steampipe 폐기) | 운영우수성·안정성·비용 |
| [002](002-auth-and-login.md) | 인증·로그인 | Cognito+Lambda@Edge RS256 + 인앱 `/login`(USER_PASSWORD_AUTH), Hosted UI 다크폴백 + Aurora `session_revocations` 기반 서버측 로그아웃 무효화(revocation, **live** — BFF-side에서 검사, edge는 JWT-only). Amended 2026-08-19(PR #228): `is_public()` 허용목록이 11개 정확매치(PWA 정적 자산 5종 포함)로 실제 코드와 일치하도록 정정 | 보안 |
| [003](003-ai-agent-routing.md) | AI 에이전트 라우팅 | 하이브리드(정규식+Haiku 분류기) + 교차도메인 자동합성 (LIVE) | 운영우수성 |
| [004](004-agentcore-gateways-runtime.md) | AgentCore 게이트웨이·런타임 | **9 게이트웨이 프로비저닝 / 9 섹션 에이전트 라우트** (external-obs 승격 2026-06-24: Prometheus+ClickHouse) + Memory + Code Interpreter. **§7(2026-07-31 amendment, 사실 기록): Aurora Data API agent Lambda는 master secret 대신 최소권한 `awsops_sql_reader`로 인증하고, `sql_reader` 스키마의 명시적 컬럼 VIEW에만 SELECT를 부여(`public`에는 table/column grant 0). 테이블 allowlist는 컬럼 단위 fail-open으로 `eks_registrations.auth`, 이어 `worker_jobs.task_token`(SFN capability token)을 누출해 폐기. host 계정 PostgreSQL 전용이며 권한 제거이므로 신규 capability 아님** | 운영우수성 |
| [005](005-aws-mutation-autonomy-frozen.md) | AWS 변경·자율 **FROZEN** | do-not-enable; 재활성화=새 ADR+패널+owner-override | 보안·운영우수성 |
| [006](006-incident-analysis-only.md) | 인시던트 **ANALYSIS-ONLY** (GATED) | read-only triage/RCA만, 자율 mitigation 폐기 | 안정성·운영우수성 |
| [007](007-external-data-integration-governance.md) | 외부 데이터 통합 거버넌스 (keystone) | read-only=리소스 한정; 외부 read LIVE·write 2-티어 거버넌스 | 보안·운영우수성 |
| [008](008-ai-diagnosis-pipeline.md) | AI 진단 파이프라인 | raw boto3 Bedrock·15+1섹션(의도 대비 실제 포함, 총 16) 병렬렌더·포맷·비용캐싱 (스트리밍 후속); 챗 루프 `AsyncAnthropicBedrock` 실험=flag-gated dark(`ANTHROPIC_AGENT_LOOP_ENABLED`) | 운영우수성·비용 |
| [009](009-async-worker-backbone.md) | 비동기 워커 백본 | SQS+SFN+Lambda/Fargate; read-only job — `noop`/`noop-heavy`(범용 `/api/jobs`), `report`·`compliance`는 사용자 경로 기준 소유권-스코프 전용 라우트(`/api/diagnosis`, `/api/compliance/run`)로 enqueue(`schedule_dispatcher.py` 내부 직접 enqueue 예외), `datasource_index`·`insight`는 내부 전용 enqueue(사용자 제출 불가) | 안정성·운영우수성 |
| [010](010-inventory-resource-model.md) | 인벤토리·리소스 모델 | 타입 레지스트리 + flag-gated Steampipe sync→Aurora (ECS service 갭) | 안정성·비용 |
| [011](011-multi-account.md) | 멀티 어카운트 | STS AssumeRole(AWSopsReadOnlyRole; ExternalId = 3rd-party 필수 / 1st-party는 task-role ARN 핀 시 선택, amended 2026-06-26), read-only fan-out | 보안 |
| [012](012-cost-finops.md) | Cost / FinOps | Cost Explorer probe + FinOps MCP + Bedrock 비용 귀속 | 비용최적화 |
| [013](013-alerting-notification.md) | 알림·통지 | 웹훅 HMAC + SNS 통지(diagnosis_notify LIVE) + 리포트 다운로드 | 운영우수성 |
| [014](014-cross-cutting-cache-i18n-cdn.md) | 횡단: 캐시·i18n·CDN | 프리워밍·i18n(ko/en/zh/ja — UI copy + 진단 리포트 lang[2026-08-31]; 챗 응답은 미연동)·CloudFront CACHING_DISABLED | 성능효율성 |
| [015](015-operational-self-healing.md) | 운영 자가치유 | 호스트 자기 서비스 force-new-deployment 자율 복구(Aurora secret 회전), default-off·IAM 1 ARN·secret-id fail-closed; **ADR-005 불완화**(별개 범주) | 안정성·보안 |
| [016](016-v1-decommission.md) | v1 레거시 폐기 | 5단계 폐기(데이터확보→도메인컷오버→정지/유예→삭제→코드정리) + `awsops.atomai.click` v2 컷오버; owner 지시, ADR-005 무관(수동 작업) | 비용최적화·운영우수성 |
| [017](017-curated-official-mcp-presets.md) | 큐레이션 공식 MCP 프리셋 | (개정 2026-08-05) 벤더 호스팅 3종(Datadog·Dynatrace·New Relic)만 external-obs `mcpServer` target + 런타임 fail-closed 툴 allowlist(GATED); ClickHouse는 공식 `mcp-clickhouse`를 런타임 stdio 내장(`CLICKHOUSE_OFFICIAL_MCP`, Datasources 자격증명 재사용) — 자체 람다의 SSRF/read-only 1차 방어를 대체 없이 잃어 **FROZEN(do-not-enable)**; Tempo/Jaeger 자체 람다 유지, Grafana/Splunk 미지원, `custom_mcp`(임의 BYO) 폐기 불변 | 운영우수성·보안 |
| [018](018-llm-query-generation.md) | LLM 쿼리 생성 (읽기 전용) | **공통(§A)**: 스키마 이름만 Bedrock 으로, 정적 게이트 후 read-only 커넥터에서만 dry-run, 스키마 버전 캐시, AWS API 경로 없음. **경로별로 방어가 다르다** — 관련성 게이트·식별자 정화·주 3회 예산·읽기측 플래그 게이트·생성물의 칩 전용 제한은 `diag_signal_querygen_enabled`(§B)에만 있고, `graph_querygen_enabled`(§C)에는 없다(Code Interpreter 사전검사는 반대로 §C 에만). 둘 다 기본 false | 보안·비용·신뢰성 |
| [019](019-athena-flow-log-query-classification.md) | Athena Flow Log 조회 분류 (read-only 불변식 내부) | Athena/Glue read-query(StartQueryExecution/GetQueryResults/StopQueryExecution 등)는 기존 CloudWatch Logs Insights 패턴과 동형 — ADR-005 완화·ADR-007 티어 불필요. 결과 write는 고객 사전설정 워크그룹 위치로 한정, AWSops가 버킷 생성/관리 안 함. **역할 2개, 섞이지 않음**: rule 인벤토리는 기존 `AWSopsReadOnlyRole`(web/Steampipe/agent와 동일 패턴)의 새 호출자일 뿐이지만, Athena 활동 파이프라인은 대상 계정의 신규·격리된 `AWSopsSgRuleAthenaRole`을 assume하며 `AWSopsReadOnlyRole`은 건드리지 않는다(§4). `sg_rule_activity_enabled`는 이 결정에 따라 §2에 **일반 GATED 항목**으로 등록(ADR-005 완화·owner-override 예외 아님 — read-only 불변식 내부라는 결론 그 자체). `network_path_check_enabled`는 이 ADR의 범위 밖(§Decision이 명시) — 이 결정에 의존하지 않는다 | 보안·비용 |
| [020](020-finops-baseline-recommendations.md) | FinOps 기본 권장 엔진 (ADR-012 확장) | 결정론적 룰 엔진이 판정·금액을 소유(별도 우선순위 필드는 향후 확장, 현재는 금액순 정렬), LLM은 국소 설명만(숫자 불일치 시 폐기); 금액 근거는 `inventory_resources` 요율표 + Compute Optimizer로 한정(CE/COH/Budgets 기반 룰은 카탈로그 등록만, 이번 버전 미호출; CUR 부재 — CUR 전제 룰은 `requires_cur`로 미구현 등록); 절감액 미상 시 NULL(0 금지); finding은 계정/리전으로 스코프; 룰 실패 시 `finops_runs.status='partial'`로 가시화; 일별 배치, 요청 경로 라이브 AWS 호출 없음; `finops_baseline_enabled`(기본 false). 부수: ADR-012가 서술했던 COH IAM 권한을 이 PR에서 실제로 부여 | 비용최적화 |
| [021](021-quota-isolated-inventory-reads.md) | 쿼터 격리 인벤토리 읽기 | **Phase 1 저장소 구현 완료; 이 agent는 apply 미실행, controller 배포 상태 별도 확인**: Steampipe limiter(4/4/2), sync concurrency 4, stale 30분, structured state. **현재 limited ops Aurora reader + direct domain target 공존**; Phase 2 domain 확장/retirement와 Phase 3 cache는 pending, ADR-005 FROZEN 불완화 | 신뢰성·운영우수성·성능·보안 |

새 ADR 추가: 최고번호+1, single Status, **같은 PR에서 이 §3(또는 §2) 갱신 필수**(anti-drift, §1).
