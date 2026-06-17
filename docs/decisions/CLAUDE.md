# Architecture Decision Records (ADR)

주요 설계 결정 기록. 상태/결정/결과가 변경되면 이 파일을 업데이트.
Records of major design decisions. Update this index when status/outcome changes.

## 규칙 / Conventions
- 파일명: `NNN-kebab-case-title.md` (3자리 제로패딩)
- 구조: Status / Context / Decision / Consequences (Positive / Negative / Post-acceptance deviations)
- Status 값: `Proposed`, `Accepted (YYYY-MM-DD)`, `Superseded by NNN`, `Deprecated`
- 한국어/영어 병기

## 목록 / Index

| # | 제목 / Title | 상태 / Status |
|---|---|---|
| 001 | Steampipe pg Pool (CLI 배제) | Accepted — v2 호스트 위치는 030이 승계 (pg Pool 결정 유효) (030 메커니즘은 037이 정정 — 라이브 Steampipe 없음) |
| 002 | AI 하이브리드 라우팅 | Accepted — 라우트 4→11 확장 (현황은 011/016/025) |
| 003 | SCP 차단 컬럼 처리 | Accepted |
| 004 | Gateway 역할 분리 | Accepted — 게이트웨이 수 7→8 정정 |
| 005 | VPC Lambda → Steampipe 접근 | Accepted — v2 네트워킹 경로는 030이 승계 (030 메커니즘은 037이 정정 — 라이브 Steampipe 없음) |
| 006 | Cost 가용성 Probe | Accepted |
| 007 | 리소스 인벤토리 베이스라인 | Accepted |
| 008 | 멀티 어카운트 지원 | Accepted |
| 009 | 알림 트리거 AI 진단 | Superseded by 032 (2026-06-09) — 032 Accepted; 상관분석 엔진은 032 Triage로 보존·이월 (원안 Accepted 2026-04-22) |
| 010 | 이벤트 기반 사전 스케일링 (Phase 1+2) | Accepted (2026-04-26) |
| 011 | 외부 데이터소스 통합 | Accepted (v1 스코프) — **v2는 ADR-039가 승계 (2026-06-16)**: SSRF 방어는 그대로 승계하되 BFF 라우트(`/api/datasources`)+`data/config.json` 메커니즘은 v1 전용, v2는 단일 MCP egress substrate(agent.py)+Secrets Manager |
| 012 | SNS 알림 전략 | Accepted (2026-04-22) |
| 013 | 자동 수집 조사 에이전트 | Accepted (2026-04-22) |
| 014 | 리포트 프록시 다운로드 URL | Accepted (2026-04-22) |
| 015 | FinOps MCP Lambda | Accepted (2026-04-22) |
| 016 | Bedrock 모델 선택 전략 | Accepted (2026-04-22) |
| 017 | 캐시 워머 프리워밍 전략 | Accepted (2026-04-22) |
| 018 | AgentCore Memory 격리/보존 | Accepted (2026-04-22) |
| 019 | 진단 리포트 포맷 매트릭스 | Accepted (2026-04-22) |
| 020 | Cognito + Lambda@Edge 인증 아키텍처 | Accepted (2026-04-22) |
| 021 | AI 응답 SSE 스트리밍 | Accepted (2026-04-22) |
| 022 | 알림 웹훅 HMAC-SHA256 인증 | Accepted (2026-04-22) |
| 023 | Admin Role Model (adminEmails) | Accepted (2026-04-22) |
| 024 | CDK 3-Stack 분할 (Awsops/Cognito/AgentCore) | **Superseded by 037 (2026-06-10)** for v2 (CDK 폐기 → Terraform) — Accepted as v1 history, Lambda 수 20 |
| 025 | 멀티 라우트 병렬 Synthesis | **Superseded by ADR-044 for v2 (2026-06-16)** — 메커니즘(병렬 fan-out+자동합성)은 ADR-044 하이브리드로 v2 승계; v1 본문은 이력 (orig Accepted 2026-04-22) |
| 026 | i18n LanguageProvider | Accepted (2026-04-22) |
| 027 | Code Interpreter 세션 격리 | Accepted (2026-04-22) |
| 028 | CloudFront CACHING_DISABLED | Accepted (2026-04-22) |
| 029 | 변경 작업 프레임워크 (ADR-010 Phase 3 게이트) | **⛔ REVERSED (2026-06-11)** — 3-AI 합의; mutating 방향 폐기, do-not-enable·substrate 동결(flag-OFF). **(2026-06-14 ADR-040 좁은 carve-out: 비-AWS-리소스 외부 knowledge/comms write에 한해 §7 통제로 거버넌스; AWS-리소스 변경은 동결 유지.)** (orig) Accepted (2026-06-09) — 멀티AI 합의(REVISE×2/AWC×1) 반영 개정; 메커니즘은 036 하이브리드로 위임, v2(Terraform/Fargate/Aurora) 현행화·기술 정정, 6대 통제 유지. **(2026-06-16 스코프 정정: '동결'=AWS-리소스 한정; 통제·lambda executor는 비-AWS 외부 DATA write에 재사용 가능[ADR-040/041], decoupled=별도 게이팅 층이며 공유 P2 SFN spine·별도 엔진 아님 — ADR 배너 참조)** |
| 030 | ECS Fargate 워크로드 + Aurora 앱 상태 + 이중 ECR | Accepted (2026-05-27) — **메커니즘(4-컨테이너/Service Connect Steampipe/CDK)은 037이 정제·부분 승계**; Aurora·이중 ECR 의도는 유효. (스키마 카운트는 030 시점 스냅샷 — 현행은 schema.sql(v9)+ULID 마이그레이션) |
| 031 | 런타임 커스터마이즈 에이전트·스킬 (관리자 구성 Agent Space + BYO-MCP) | **⚠️ PARTIALLY REVERSED (2026-06-11)** — Phase 1(LIVE)·Phase 2(deployed) 유지; **Phase 3(BYO-MCP)·Phase 4(mutating 도구) 폐기**(3-AI 합의). **(2026-06-14 ADR-040: Phase 4 중 비-AWS-리소스 외부 write만 좁은 carve-out; BYO-MCP[P3]·AWS-리소스 변경은 폐기 유지.)** (orig) Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); mutating BYO-MCP 거버넌스 경유·revocation fail-closed·BYO-MCP 하드닝·인젝션 가드 보완 |
| 032 | 이벤트 트리거 자율 인시던트 라이프사이클 (멀티 에이전트 Lead/Sub) | **⚠️ DOWNGRADED (2026-06-11)** — 3-AI 합의; 자율 mitigation/action 폐기(029/036 reversed), read-only Triage/조사/RCA만 유지(권고전용, 활성화 시 analysis-only). (orig) Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); 034/036 관계·P2 실행 바인딩·look-back 설정값화·Lead 최소권한 보완 |
| 033 | AIOps LLM 비용 최적화 (Haiku 분류·프롬프트 캐싱·응답 캐시·토큰 예산) | Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); 프롬프트 캐싱 범위 정정(게이트웨이 호출 불투명)·sourceDataFingerprint·예산 영속 보완; Phase 2 (Aurora durable budget) 구현, 의미 캐시는 v2 AI 라우트 동반 후속 페이즈로 연기 |
| 034 | 알림 자동 RCA 라이트백 (OpsCenter/Incident Manager 양방향 보강) | Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); 피드백루프 차단 메커니즘·observability-write 통제 부분집합·best-effort 보완 |
| 035 | K8sGPT 하이브리드 (MCP로 AgentCore에 통합하는 인클러스터 K8s 진단, Haiku 4.5) | **⚠️ DOWNGRADED (2026-06-11)** — 3-AI 합의; read-only Result-CRD 통합만 유지(GET-only), **H3a(→032/034/029 제안) 배선 폐기**. (orig) Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); Rule 5 강화 + 7~11 추가 |
| 036 | 변경·조치 실행 substrate (SSM Automation + Change Manager × P2 워커 백본 하이브리드) | **⛔ REVERSED (2026-06-11)** — 3-AI 합의; 029와 함께 실행 substrate 폐기, do-not-enable·동결. **(2026-06-14 ADR-040: P2 워커 lambda executor를 비-AWS-리소스 외부 write에 한해 분리·재사용; SSM/Change-Manager AWS-리소스 자동화는 동결 유지.)** (orig) Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); `.sync` 사실오류 정정·완료추적·승인주체·per-action IAM·통제 매핑 보완. **(2026-06-16 스코프 정정: '동결'=AWS-리소스[SSM/Change Manager] 한정; 동일 P2 spine의 lambda executor 분기는 비-AWS 외부 DATA write에 재사용[ADR-040/041]·별도 엔진 아님 — ADR 배너 참조)** |
| 037 | v2 파운데이션 — Terraform + thin-BFF 웹 + 비동기 워커 (CDK 폐기) | Accepted (2026-06-10) — co-agent ADR 일관성 리뷰; 024 전면 승계 + 030 메커니즘 정제(Steampipe 라이브 없음·flag-gated 인벤토리 sync 확정) (029/036은 이 파운데이션 위에 설계됐으나 2026-06-11 REVERSED — 037의 채택 자체는 029/036 reversal에 영향받지 않음) |
| 038 | 하이브리드 에이전트 라우팅 (정규식+Haiku 분류기) + v2 프롬프트 캐싱 | Accepted (2026-06-10) — 멀티AI 의사결정(A-now/C-at-P4 만장일치) + 스펙 리뷰 8건 반영; Gateway 시맨틱 P4 연기; **활성화 LIVE (2026-06-10): 게이트 hybrid 96.9% (+27.7pp) PASSED·캐싱 GREEN·분류기 타임아웃 3.5s 정정** |
| 039 | 멀티 에이전트 플랫폼 — 프런티어 에이전트(DevOps/Security/FinOps + N) + Integrations 축 (ADR-031 확장) | Accepted (2026-06-13) — 멀티AI co-agent 합의(7-리뷰어 ADR 모순 교차검증 + 의사결정 패널 Q1만장일치/Q2chair/Q3+hedge + 대안·리스크 패널). 4기둥(Frontier Agents·Skills·Integrations[Option 4 단일 MCP substrate, READ/READ_WRITE, ingress+egress]·Agent Spaces); 페더레이션=032 재사용; mutating gate=029/036; **P1·P2 구현 완료 + P2-infra inc1/inc2 배포**(egress READ 라이브 MCP). **2026-06-11 reversal 정합화(2026-06-14 §Amendment)**: egress READ-only(inc2)=reversal과 양립(쓰기·자율 없음, SAFEGUARD+allowlist+SSRF); **READ_WRITE write 경로는 ADR-040이 좁게 거버넌스**(외부 knowledge/comms write만 carve-out, AWS-리소스 변경·자율은 영구 reversed). 스펙 `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md` |
| 040 | 거버넌스된 외부 지식·커뮤니케이션 쓰기 (2026-06-11 reversal의 좁은 해제) | Accepted (2026-06-14) — co-agent 패널(조건부 ②다수 3: 강한 반대[opus] 1: 무응답 1) + **owner 확정**. 2026-06-11 reversal을 **대체 아님** — **외부 knowledge/comms write(Slack/Notion/Confluence/Jira/ServiceNow 기록·메시지)만** ADR-039 §7 mutating-gate 통제 하 좁게 해제(**비-AWS-리소스 전용**; AWS-리소스 변경·자율은 029/036/031-P4 영구 reversed 유지). 7대 하드조건(특히 **exfiltration DLP/redaction+목적지 allowlist**[반대표 핵심], non-AWS-only, §7 전체통제, 분리 substrate, BYO-MCP 금지, ADR-012 대비 가치, flag-OFF). 구현 deferred. 패널 `docs/reviews/2026-06-14-external-write-unfreeze-consensus.md`. **(041이 keystone으로 재정합 — '예외'가 아니라 데이터-write 표준 거버넌스)** |
| 041 | "read-only"는 리소스 read-only — 외부 데이터 통합(read+write)은 거버넌스 하 허용 (keystone) | Accepted (2026-06-14) — **owner clarification + re-scope** of 2026-06-11 reversal. 핵심 원칙: **read-only 제약 = AWS-리소스 변경 + 자율**(SSM/infra/autonomous action 동결 유지), **외부 데이터(read+write)는 아님**. 외부 관측성 read·외부 기록/티켓/메시지 write는 DATA 연산이지 리소스 변경 아님 → AWS DevOps/FinOps/Security agent 통합 모델. 2026-06-11의 'external-endpoint' 우려는 **금지가 아니라 통제 mandate**로 재해석(SSRF·Secrets·DLP/redaction·큐레이션·human-gate·flag). 029/036/031/032/039/040을 이 원칙으로 재정합(표 포함). 029/036=리소스 변경만 동결·facade는 데이터-write 재사용 가능, 031-P3=큐레이션 데이터 커넥터 허용·임의 BYO-MCP 제외, 032=자율 리소스 mitigation만 동결 **(+2026-06-17 coherence addendum: 멀티-AI 정합 패널[opus+gemini 교차합의]이 리소스/데이터 이분법의 seam 지적 → ADR-034 OpsCenter/Incident Manager write를 **제3티어=AWS-네이티브 관측 메타데이터 write**로 명시[Decision §1 FROZEN 아님, 데이터처럼 거버넌스]; 단 034는 frozen 029/036 role 상속으로 **자족 role 분리+`rca_writeback_enabled` 전까지 flag-OFF·do-not-enable**)** |
| 042 | v2 인앱 로그인 (Cognito USER_PASSWORD_AUTH) | Accepted (2026-06-12) — **번호 정합: 039→042 (co-agent 패널 Option A 만장일치, 2026-06-15)**. 병합 시 origin이 039(멀티에이전트)/040/041을 선점·교차참조하여, leaf인 본 로그인 ADR을 042로 재배정(파일 `042-v2-inapp-login.md`). 자체 `/login` 폼 + 무서명 공개 `InitiateAuth(USER_PASSWORD_AUTH)`가 Hosted UI를 주 경로에서 대체; 엣지 RS256 검증기·`awsops_token` 쿠키 계약 불변(037 기반·020 정제); 최소권한(REFRESH 미부여)·id_token 12h·Hosted UI PKCE는 다크 폴백·signout은 쿠키 삭제→`/login` |
| 043 | Neptune 그래프 substrate (옵션) — 토폴로지·DevOps 에이전트 공용 | Accepted (2026-06-?) — **번호 정합: 040→043 (co-agent 패널 Option A, 2026-06-15)**. 동시 세션이 040으로 생성했으나 origin 040(외부쓰기 거버넌스)과 충돌하여 leaf로서 043 재배정(파일 `043-neptune-graph-substrate.md`). Postgres-first·Neptune deferred 옵션. 상세는 ADR 파일 참조 **(+2026-06-17 addendum: 5-패밀리 합의로 Postgres-first 재확인; Neo4j는 ECS+EBS 내부배포 한정 조건부 후보[Aura 배제]; 토폴로지 UI=현행 클라 빌드 유지[서버 materialize는 트리거 시]; materialize cadence=daily·소비자 등장 시 배선; 에이전트 RCA 시 투트랙)** |
| 044 | v2 챗 멀티-도메인 라우팅 — 하이브리드(단일 라우트 + ADR-025 교차도메인 자동합성) + Thread/Agent 바인딩 | Accepted (2026-06-16) — 멀티-AI 모순 패널(kiro-cli/Opus + antigravity/Gemini-3.1; codex 불가) → owner 결정. **A1**(025↔038 챗 라우팅 정반대·미결) + **A2**(thread↔agent 바인딩 미정의 + picker핀/전환칩 데드락) 정합화. **v2에 대해 ADR-025 승계** + **ADR-038 개정**(우선순위 래더에 Agent Space 필터, 전환칩이 picker 핀 해제, classifier 멀티-라우트 반환). 하이브리드: 명확질의=단일 게이트웨이, 교차도메인=자동합성(전환칩=보조). 멀티-에이전트 3모델 경계 명시(챗=025/044, 인시던트=032, 외부통합=039) |

## 새 ADR 추가 / Adding a New ADR
1. 번호: `ls docs/decisions/*.md | tail -1` 로 최신 번호 확인 후 +1 (현재 최고 번호 = **044**)
2. `.template.md` 를 복사하여 시작
3. Status 는 `Proposed` 로 시작 — 결정 확정 시 `Accepted (YYYY-MM-DD)` 로 변경
4. 이 인덱스에 한 줄 추가

## 관련 스킬 / Related Skill
- `/project-init:add-adr` — 자동 번호로 새 ADR 생성
