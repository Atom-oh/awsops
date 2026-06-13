# ADR-039: Multi-Agent Platform — Frontier Agents + Integrations Axis (extends ADR-031) / 멀티 에이전트 플랫폼 — 프런티어 에이전트 + Integrations 축 (ADR-031 확장)

## Status / 상태

Accepted (2026-06-13) / 채택 (2026-06-13) — 멀티AI co-agent 합의(kiro-kimi/glm · codex · gemini): ADR 모순 교차검증(7 리뷰어) + 의사결정 패널(Q1 만장일치 C, Q2 chair 결정, Q3 다수+보수 hedge) + 대안/리스크 패널. **ADR-031을 확장**(대체 아님); 메커니즘은 ADR-036, 페더레이션은 ADR-032 재사용. 구현은 단계적(P1 완료, P2~ backlog). 동반 스펙: `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md`(객체 모델·스키마·UX·페이징·ADR 정합성 §16).

This ADR records the decision; implementation detail lives in the companion spec. / 이 ADR은 결정을 기록하고, 구현 상세는 동반 스펙에 있다.

## Context / 컨텍스트

AWSops는 AWS 프런티어 에이전트 패밀리(DevOps Agent · Security Agent, 곧 FinOps Agent)의 커스터마이즈 모델을 차용하려 한다: 운영자가 콘솔에서 **에이전트·스킬·외부 통합을 항목별로 구성**하고, 고정 세트를 코드에 박지 않는다. ADR-031은 런타임 커스터마이즈(카탈로그 + resolver + Agent Space + registry-agnostic `agent.py`)를 이미 정했으나, (1) 단일 에이전트 관점이라 **여러 프런티어 에이전트(N 확장)** 개념이 없고, (2) 외부 통합이 **BYO-MCP(egress) + ADR-011 datasource**로 흩어져 있으며, (3) **외부 알람 ingress**·**read/write 통합(Notion/Confluence/Slack)**·**페더레이션**·**멀티계정 UX**가 통합 모델로 정리돼 있지 않다. 또한 ADR-031 구현 드리프트(`agent.py`가 `toolAllowlist` 무시 = no-op, revocation 30s 캐시, 카탈로그 테이블이 ULID 마이그레이션에 부재)가 확인됐다.

AWSops adopts AWS DevOps/Security Agent customization (compose agents/skills/integrations item-by-item, per account, no rebuild). ADR-031 set the runtime-customizable substrate but is single-agent-shaped and leaves external integration, ingress, read/write writes, federation, and multi-account UX un-unified — plus confirmed implementation drift (toolAllowlist no-op, 30s revocation cache, catalog tables missing from ULID migrations).

## Decision / 결정

AWSops를 **여러 프런티어 에이전트(DevOps/Security/FinOps + N 확장)를 호스팅·커스터마이즈하는 플랫폼**으로 만든다. **공유 substrate(공유 AgentCore Runtime + Aurora 카탈로그 + resolver + registry-agnostic `agent.py`)는 유지** — 커스터마이즈는 데이터이지 재빌드가 아니다. **4개 기둥:**

1. **Frontier Agents** — `agents`를 1급 프런티어-에이전트 엔티티로 확장(멀티-게이트웨이 스코프 `gateways[]` + `agent_type`[generic/on_demand/triage/rca/mitigation/evaluation] + 응답언어). DevOps/Security/FinOps는 builtin 시드, custom도 동형. FinOps는 기존 **ADR-015** FinOps MCP를 조합.
2. **Skills** — SKILL.md(frontmatter + Markdown) + references/assets(S3) + agent-type 타게팅 + 폼/zip 작성 + 경량 AI-assist.
3. **Integrations 축 (Option 4)** — 외부 커넥터를 **단일 MCP 실행 substrate 위의 타입드 카탈로그/UX/거버넌스**로. `direction`(egress/ingress) + `capability`(READ/READ_WRITE). egress READ 관측성은 **ADR-011**의 v2 재유도(SSRF 방어 승계), READ_WRITE 쓰기(Notion/Confluence/Slack/Jira)는 **ADR-029/036 mutating gate**(단일 P2 스파인) 경유, ingress 웹훅 알람 소스는 **ADR-022**(소스별 인증) + **ADR-032** triage. 외부 관측성 = Integrations(내부 CloudWatch = `monitoring` 게이트웨이; **ADR-004 게이트웨이 수는 8 유지**). `integrations`는 ADR-031 `mcp_registrations`를 승계(글로벌 카탈로그 + 계정별 활성화·자격증명 격리).
4. **Agent Spaces** — 계정별 활성화·스코핑·도구 cap(+ enabled integrations + 응답언어).

**R1 페더레이션**: DevOps/Security/FinOps 협업 = **ADR-032 Lead/Sub** 재사용(새 오케스트레이션 엔진 없음). **R2 read/write**: AWS의 read-only를 넘어 거버넌스된 쓰기. **멀티계정**: v2에 도입(ADR-008의 v2 후속 = 계정 레지스트리 + cross-account AssumeRole 필요). **UX**: Integrations·Agent Spaces는 1급 페이지, 저빈도 admin(Accounts/Admin/OpenCost 설치)은 **Settings 허브**(co-agent Q1 만장일치). **권한**: 등록(egress/자격증명)=admin, **폼 기반 작성=일반 사용자(per-account `nonAdminAuthoring` 플래그 default-OFF)**, zip 업로드·enable=admin.

**보안 다층(현존 갭 마감 포함)**: `agent.py` `toolAllowlist` 서버측 강제(no-op 해소), fail-closed revocation, ADR-011 SSRF 방어(DNS 사전해석·private-CIDR/metadata 차단·`redirect:manual`·private opt-in), 쓰기는 mutating gate(plan→execute·dry-run·4-eyes[+로그된 single-operator escape]·paired rollback·audit·kill-switch), Secrets Manager 자격증명, ADR-018 per-user+account 메모리 격리, ADR-033 per-account+userSub 토큰 예산, zip은 cosign(ADR-031 P3)까지 admin-only.

**Phased**: P1(파운데이션+갭마감, **구현 완료**) → P2(Integrations READ + ingress) → P3(READ_WRITE + AI-assist) → P4(페더레이션) → P5(Learned Skills). 신규 결정면이므로 **ADR-031 개정이 아닌 신규 ADR-039**로 채택(ADR-032의 "결정면별 ADR" 원칙).

Adopt a **multi-frontier-agent platform** on the shared ADR-031 substrate (customization is data, not a rebuild): four pillars — **Frontier Agents** (first-class `agents` entity: multi-gateway scope + agent_type + response language; DevOps/Security/FinOps builtin seeds, FinOps composes ADR-015), **Skills** (SKILL.md + references/assets + agent-type + form/zip + AI-assist), **Integrations axis** (Option 4: typed catalog/UX/governance over ONE MCP substrate; direction egress/ingress; capability READ/READ_WRITE; egress-READ observability re-derives ADR-011 with its SSRF defense; READ_WRITE writes via the single ADR-029/036 P2 gate; ingress webhook sources via ADR-022 per-source auth + ADR-032 triage; external obs = Integrations, internal CloudWatch = monitoring gateway, ADR-004 count stays 8; `integrations` supersedes ADR-031 `mcp_registrations` as a global catalog + per-account enablement/credential isolation), **Agent Spaces** (per-account enablement/scoping + tool cap). **R1 federation** reuses ADR-032 Lead/Sub; **R2** governed writes; **multi-account** is in scope (needs a v2 ADR-008 successor); **UX** keeps Integrations + Agent Spaces first-class with a Settings hub for low-frequency admin; **permission** relaxation (non-admin form-authoring) behind a default-off per-account flag, enable/upload/registration admin-only. Multi-layer security closes the known ADR-031 gaps. Ratified as a NEW ADR-039 (extends, not supersedes, ADR-031).

## Considered Alternatives / 고려한 대안

(패널 보강 — codex/gemini/kiro 기여 표기)

- **생성형 per-agent 런타임("agentcore creator")** — 프롬프트→에이전트별 전용 AgentCore Runtime 프로비저닝. 완전 격리·임의 코드 가능하나 분 단위 배포·비용·IAM 표면, 그리고 "재빌드 없음" substrate와 충돌. **기각**(사용자 de-scope; data-driven substrate 유지).
- **현 상태 — 하드코딩 SKILL_BASE + 고정 게이트웨이**(gemini). 최대 안정성이나 확장 불가. **기각**.
- **Integrations 모델링 4안**(co-agent 결정): (1) 별도 bespoke 통합 서비스 — 두 번째 substrate, 기각; (2) 현행 섹션 게이트웨이 — 기각; (3) 순수 generic MCP / `action_catalog`-only(타입드 카탈로그 없음) — AWS 모델 패리티·READ/WRITE 분류·allowlist 세분화 상실, 모든 read를 gate로 강제(kimi), 기각; (4) **단일 MCP substrate 위 타입드 카탈로그 — 채택**(codex+gemini 만장일치, kiro 단일-substrate 동의).
- **Integration 등록: 계정별 vs 글로벌 카탈로그+활성화** — 글로벌 카탈로그 + 계정별 활성화·자격증명 선택(중복 커넥터 정의 회피 + 격리 보존; codex). ADR-031 per-account `mcp_registrations`에서의 의도적 변경.
- **외부 관측성을 새 `external-obs` 섹션 게이트웨이로** — 기각; 관측성 = Integrations egress READ, ADR-004 수 8 유지(codex).
- **권한: 완전 admin-only(ADR-031 기준선) vs 완화** — default-off `nonAdminAuthoring` 플래그 뒤 완화 채택; enable/업로드/등록은 admin(Q3; codex의 default-off hedge 반영).
- **페더레이션: 신규 오케스트레이션 엔진 vs ADR-032 재사용** — ADR-032 Lead/Sub 재사용.
- **ADR-031 개정 vs 신규 ADR-039** — 신규 ADR-039(신규 결정면; 채택된 ADR을 암묵 확장 금지 — ADR-032 원칙).

## Consequences / 결과

### Positive / 긍정적
- 데이터 기반 N-에이전트 확장 — FinOps 추가 = 시드 row + capability 와이어링(코드 포크 아님). / Data-driven N-agent extensibility.
- 단일 강화 egress substrate(SigV4→IAM, OAuth/API-key→Secrets Manager, ADR-011 SSRF 차단 승계) — N개 경로 대신 하나. / One hardened egress path.
- 거버넌스된 쓰기 — READ_WRITE는 ADR-029/036 gate(plan→execute, dry-run, paired rollback)로; 모델이 raw write 미노출 → 데이터 유출 난이도↑·감사 단순화. / Governed writes; harder exfiltration, simpler audit.
- 페더레이션 재사용(ADR-032) — DevOps+Security+FinOps 협업이 Agent Space roster 문제로 환원, 새 머신 없음.
- 현존 보안 갭 마감: `toolAllowlist` 실강제, fail-closed revocation, 마이그레이션 드리프트 복구.
- ingress+egress 통합 운영자 멘탈 모델(AWS Capability Providers 패리티). / Unified ingress+egress operator model.
- `nonAdminAuthoring` default-OFF — ADR-031 보수적 자세 보존하며 조직별 opt-in 확장.

### Negative / 부정적 (리스크)
- `agent.py` `toolAllowlist` 강제는 **런타임 동작 변경** — 전 게이트웨이/스킬 대상 테스트 필요(오차단 방지). *(P1에서 구현·테스트 완료.)*
- READ_WRITE는 쓰기 표면 확대 — 커넥터마다 executor + dry-run + paired rollback + 승인 plumbing(운영 부담↑).
- **멀티-게이트웨이 프런티어 실행은 P4로 연기** — P1 단일-게이트웨이라 에이전트가 실제 실행보다 넓어 보일 수 있음.
- **멀티계정이 load-bearing이나 P1 미배달** — v2 계정 레지스트리/cross-account AssumeRole(ADR-008 후속) 전까지 `'self'` placeholder.
- SaaS ingress webhook = Lambda@Edge **Cognito-everywhere 예외(carve-out)** — 노출 표면 확대; per-source 인증(벤더 서명, 균일 HMAC 아님)·source allowlist·ADR-022/012 검증이 보안 경계.
- egress가 VPC 내부 자산 근처에서 동작 → **ADR-011 SSRF 방어 필수**(DNS·private CIDR·redirect·opt-in 테스트).
- 글로벌 카탈로그 + 계정별 자격증명은 운영상 미묘 — Agent Space 스코핑 버그 시 계정 간 활성화/컨텍스트/자격증명 누출 위험.
- `nonAdminAuthoring`(default-off라도) 프롬프트/설정 남용 경로 — disabled-by-default·admin-only enable·불변 SAFEGUARD·서버측 allowlist가 안전망.
- 컨텍스트 주입 + 다수 스킬로 프롬프트/비용 팽창 — ADR-033 per-user/account 예산 + Agent Space cap 필요.
- resolver 패리티(`web/lib/agent-resolver.ts` ↔ `scripts/v2/incident/agent_bridge.py`) 필수 — 드리프트 시 chat/federation 안전 규칙 불일치.
- 공급망: zip 업로드는 cosign(P3) 전까지 admin-only.

### Post-acceptance deviations / 채택 후 편차
- **ADR-031 Addendum #6(admin-only authoring) 완화** — 폼 작성은 일반 사용자(per-account `nonAdminAuthoring` default-OFF); 업로드/enable은 admin 유지. (co-agent Q3)
- **ADR-031 per-account `mcp_registrations` → 글로벌 `integrations` 카탈로그 + 계정별 활성화** — 격리는 자격증명 스코핑 + Agent Space 활성화로 보존(Addendum #4).
- **ADR-004**: external-obs는 9th 게이트웨이가 아니라 Integrations 축으로 — 정식 게이트웨이 수는 8 유지(ADR-004 노트 갱신 필요).

## References / 참고 자료

- Companion spec: `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md` (§16 ADR reconciliation table).
- Reference model: AWS DevOps Agent / Security Agent (Agent Space, Skills, Capability Providers, dual-console); FinOps Foundation framework.
- Extends **ADR-031** (Addenda #2/#4/#5/#6). Consumes: ADR-004 (gateway split, count=8), ADR-008 (multi-account), ADR-009 (superseded by 032; correlation→Triage), ADR-011 (datasource layer + SSRF), ADR-012 (SNS/Slack), ADR-015 (FinOps MCP), ADR-018 (memory isolation), ADR-021 (SSE), ADR-022 (HMAC webhook ingress), ADR-023 (admin model), ADR-025 (chat multi-route synthesis), ADR-029/036 (mutating gate), ADR-032 (Lead/Sub federation + Triage), ADR-033 (cost), ADR-034 (RCA write-back + loop breaker), ADR-035 (K8sGPT — container-section, P3), ADR-037/030 (v2 foundation).
- P1 implementation: commits `ee98e14`…`44302cf` (migration + agent.py enforcement + KNOWN_TOOL_CATALOG + fail-closed revocation + catalog/validation/API/UI; web vitest 559 green).
