# 결정 베이스라인 리셋 — 설계 문서 (Decisions Baseline Reset)

> 작성 2026-06-21 · 브랜치 `feat/v2-architecture-design`
> 목적: 45개로 누적되며 번복 체인이 5~6겹 쌓인 ADR 더미가 매 세션 AI에게 모순을 주입하는 문제를, **단일 현행 진실 문서(BASELINE)** 도입 + **옛 ADR 동결(archive)** 로 끝낸다.

## 1. 문제 (Problem)

- ADR이 001~045로 누적. 029·031·032·035·036·039·040·041의 Status 칸이 `REVERSED → carve-out → DOWNGRADED → owner-override → clarification → scope 정정 → addendum` 식으로 한 줄에 모순 조항이 다층 누적됨.
- "지금 무엇이 진실인가"를 한눈에 말하는 단일 문서가 없음 → AI는 매 세션 45개 ADR + 번복 체인을 *재생(replay)* 하여 현행 진실을 재구성해야 함 → 모순 재생산.
- 기록은 보존해야 하지만(요구), 보존이 곧 **음의 가치**(AI를 오도)가 되어 있음.
- 근본 원인: 고정된 **북극성(목표/가치/핵심설계)** 이 없어 각 결정의 정당성을 검증할 기준이 부재 → 번복이 반복됨.

## 2. 북극성 (North Star) — 확정

### 목표 (Goal)
> **AWSops는 AWS에 올라가는 모든 리소스를 AWS Well-Architected 6대 기둥에 맞게 안전하고 빠르게 운영하도록 돕는다.**
> 6대 기둥: 운영 우수성 · 보안 · 안정성 · 성능 효율성 · 비용 최적화 · 지속가능성.
> 다양한 데이터소스와 에이전트로 **6대 기둥 관점의 진단과 해결방법 제시**를 제공하여 운영을 지속적으로 고도화한다.

"안전하게"는 목표의 일부다. 따라서 지금까지의 read-only 번복은 "후퇴"가 아니라 **"안전을 위해 실행 경로를 신중히 게이팅한 것"** 으로 재해석된다.

### 가치 (Value)
- **단일 창에서 6대 기둥을 본다** — 인벤토리·토폴로지(안정성), 비용(비용 최적화), 보안/CIS(보안), 메트릭(성능), 진단(운영 우수성)을 한 곳에서.
- **진단을 넘어 해결까지** — 라이브 데이터(AWS + 외부 관측성) + 에이전트로 근본원인을 찾고 *고치는 법까지* 제시.
- **안전이 내장** — 빠르게 운영하되 위험한 실행은 통제·게이트·사람 승인 뒤. 프로덕션에 붙여도 안전.

### 핵심 설계 (Core Design) — 4축
1. **모든 기능·진단은 6대 기둥 중 하나 이상에 매핑된다.** (새 결정의 정당성 = 어느 기둥을 개선하나)
2. **운영의 현재 형태 = 진단 + 해결방법 *제시*.** 실행은 안전 게이트 뒤(사람 승인 / 미래 거버넌스 경로).
3. **Terraform MSA** — 비공개 엣지(CloudFront VPC Origin → 내부 ALB → Fargate) · Aurora 영속 상태 · thin-BFF + 비동기 워커 · AgentCore 섹션 에이전트 · 외부 데이터소스/통합.
4. **모든 신기능 flag-gated** — 기본 OFF, 안전하게 단계적 활성화.

### 실행/자동화의 위상 — 확정: **점진적 실행 (게이트된 로드맵)**
- 최종 목표는 안전한 *실행/자동화*까지 포함한다.
- **현재는 "진단 + 제시"만 ON.** AWS 리소스 변경·자율 조치는 **"영구 금지"가 아니라 "아직 안 켬"** — 안전조건(human-gate · per-action IAM · 감사 · flag 승인) 충족 전까지 OFF.
- 외부 DATA write(Slack/Jira/Notion 등 비-AWS 기록·메시지)는 이미 거버넌스(SSRF·Secrets·DLP·human-gate·flag) 하에 허용 — 리소스 변경과 구분.
- → 옛 ADR의 `do-not-enable 영구 동결` 표현은 BASELINE에서 **로드맵 게이트**로 재서술된다.

## 3. 산출물 설계 (Deliverables)

### A. `docs/decisions/BASELINE.md` — 단일 현행 진실 문서
AI와 모든 CLAUDE.md가 **이것만** 현행 진실로 읽는다. 한국어/영어 병기. 구조:

| 섹션 | 내용 | 규칙 |
|---|---|---|
| **§0 북극성** | 위 2장(목표/가치/핵심설계/실행위상) 그대로 | 고정. 변경 시 owner 승인. |
| **§1 살아있는 결정** | 현행 동작을 토픽별 한 줄씩. 모순 0. | 각 줄 끝 `(why: ADR-0xx)` 포인터만. 상태 조항·번복 체인 금지. |
| **§2 로드맵 게이트** | 아직 OFF인 것. 각 항목 = `[무엇] + [켜는 안전조건]` | "영구 금지" 표현 금지. 조건 명시 필수. |
| **§3 불변식/용어** | read-only 정의, 6기둥 매핑 규칙, flag 규율 등 | 결정론적 판정 기준. |

- **§1 살아있는 결정**은 토픽으로 묶는다(예: 엣지/인증, 데이터/Aurora, AI 진단, 챗 라우팅, 외부 통합, 워커, EKS, 멀티계정, 비용). 각 토픽 아래 현행 동작을 단문으로. 가능하면 6기둥 태그.
- **§2 로드맵 게이트** 예시 형식:
  - `AWS 리소스 변경(SSM/Change Manager) — OFF. 켜는 조건: human-gate + per-action IAM + 완전 감사 + owner flag 승인. (배경: ADR-029/036)`
  - `자율 mitigation/인시던트 자동조치 — OFF. 켜는 조건: 점진 실행 검증 통과 + flag. (배경: ADR-032/035)`
  - `BYO-MCP(임의 외부 MCP) — OFF. 큐레이션 커넥터만 허용. (배경: ADR-031-P3/041)`

### B. `docs/decisions/archive/` — 옛 ADR 동결
- `001-*.md ~ 045-*.md` + `.template.md` 를 **내용 변경 없이** `git mv` 로 이동.
- `archive/README.md` 신규: *"동결된 역사 기록. 현행 진실 아님. 현행은 `../BASELINE.md`. 여기는 '왜 그렇게 됐나(rationale)' 추적용으로만 본다. 새 결정은 여기 추가하지 않는다."*
- 코드/문서의 `ADR-0xx` 교차참조는 `archive/`에서 그대로 resolve → 링크 안 깨짐.

### C. CLAUDE.md 2곳 + docs/CLAUDE.md 정리
- **루트 `CLAUDE.md`**: 거대한 `## ADR` 문단(045 모순 덩어리)을 **삭제**하고 → "결정의 현행 진실 = `docs/decisions/BASELINE.md`. ADR(001~045)은 `docs/decisions/archive/` 역사 기록." 로 교체.
- **`docs/decisions/CLAUDE.md`**: 엉킨 인덱스 테이블 → BASELINE을 가리키는 짧은 안내 + "새 ADR은 기록용으로 046부터, 단 같은 PR에서 BASELINE 갱신 필수" 규칙으로 교체.
- **`docs/CLAUDE.md`**: `decisions/` 설명 줄을 BASELINE 중심으로 갱신.

### D. 앞으로의 규칙 (모순 재발 방지)
1. **BASELINE.md = 유일한 현행 진실.** 결정이 바뀌면 *BASELINE을* 고친다 (체인 안 쌓음).
2. 큰 신규 결정은 ADR(046~)을 *기록용*으로 추가하되 **반드시 같은 PR에서 BASELINE 갱신**. ADR=왜, BASELINE=지금 무엇.
3. AI는 truth를 ADR 체인 재생으로 재구성하지 않는다.

## 4. §1·§2 추출 방법 (정확성 보증)

45개 ADR에서 "현행 살아있는 것"과 "게이트(OFF)된 것"을 **누락·왜곡 없이** 길어 올리는 것이 구현의 핵심 난이도다.

- **1차 추출:** 인덱스(`docs/decisions/CLAUDE.md`) Status 칼럼 + 각 ADR Status 헤더를 읽어, 각 ADR을 `LIVE / GATED-OFF / SUPERSEDED / v1-only` 4분류로 라벨링.
- **2차 검증:** 라벨링 결과를 CLAUDE.md 본문(현행 아키텍처 서술) 및 실제 코드/terraform flag(`*_enabled`)와 대조 — 문서가 말하는 LIVE와 코드의 flag 상태가 어긋나면 코드 우선, 불일치는 §1에 주석.
- **모순 제거:** SUPERSEDED·v1-only는 §1/§2에서 제외(archive에만 존재). LIVE→§1, GATED-OFF→§2.
- (선택) 추출 결과를 co-agent/멀티-AI 패널로 교차검증하여 누락·오분류를 잡는다 — owner 판단.

## 5. 비목표 (Non-Goals / YAGNI)
- ADR 재번호(001부터 재작성) **안 함** — 교차참조 파손·작업량 과다. archive 이동으로 충분.
- ADR 내용 재작성·삭제 **안 함** — 그대로 동결(기록 보존).
- 새 거버넌스 메커니즘 도입 **안 함** — 기존 결정의 *표현*만 정리.
- 코드 변경 **없음** — 순수 문서 작업.

## 6. 검증 (Verification)
- `BASELINE.md` 자체 모순 검사: §1의 어떤 줄도 §2와 충돌하지 않음. 번복/조건부 조항이 §1에 없음.
- 루트 `CLAUDE.md`에 "ADR-0xx … REVERSED … carve-out …" 식 모순 문단이 남아 있지 않음.
- `git mv` 후 `ADR-0` 문자열 참조가 깨지지 않음(archive 경로로 resolve) — grep으로 확인.
- 새 세션 시뮬레이션: BASELINE만 읽고 "AWS 변경 자동화 해도 되나?" 질문에 결정론적으로 "OFF, 조건 X" 답이 나오는지.

## 7. 리스크
- **추출 누락** — LIVE 결정을 §1에서 빠뜨리면 AI가 기능 존재를 모름. → §4 2차 검증(코드 flag 대조)로 완화.
- **archive 이동이 동시 세션 작업과 충돌** — 다른 세션이 ADR 파일을 건드리는 중이면 git mv 충돌. → 작업 직전 `git status` 확인, 작은 단위 즉시 커밋.
- **교차참조 혼선** — 일부 문서가 `docs/decisions/029-*.md` 절대경로로 참조 시 파손 가능. → grep으로 절대경로 참조 색출 후 archive로 일괄 치환.
