# 문서·결정·아키텍처 정합 리셋 — 설계 문서

> 작성 2026-06-21 · 브랜치 `feat/v2-architecture-design`
> 한 줄 요약: 누적된 ADR 모순 + 문서↔현실 drift + V1→V2 미구현/오구현 + docs/ 구조 난맥을, **고정된 북극성** 위에 **단일 현행 진실 문서(BASELINE)** + **현행/역사 분리 docs IA**로 리셋한다. 옛 기록은 동결 보존(삭제 없음).

---

## 1. 문제 (Problem)

1. **ADR 모순 누적** — 001~045. 029·031·032·035·036·039·040·041의 Status가 `REVERSED→carve-out→DOWNGRADED→owner-override→clarification→scope정정→addendum` 다층 누적 → "지금 무엇이 진실인가" 단일 출처 부재 → AI가 매 세션 체인을 *재생*하여 모순 재생산.
2. **문서↔현실 drift** — `docs/architecture.md`는 v1 기준(낡음). reference/CLAUDE.md 서술과 실제 코드/terraform flag·배포 상태가 어긋날 가능성. V1→V2 전환에서 미구현/오구현이 테스트 때마다 계속 발견됨.
3. **docs/ 구조 난맥** — 현행 설계가 2곳(architecture.md ↔ superpowers/reference), 설계·계획이 4곳(plans/·superpowers/{specs,plans,archive}), brainstorm·reviews 분산. 과정 잔여물(plans 75개 등)이 현행 진실과 같은 층에 섞여 진실을 가림.
4. **근본 원인** — 고정된 **북극성**(목표/가치/핵심설계)이 없어 각 결정의 정당성 검증 기준이 없음 → 번복 반복.

## 2. 북극성 (North Star) — 확정 (변경 시 owner 승인)

### 목표
> **AWSops는 AWS에 올라가는 모든 리소스를 AWS Well-Architected 6대 기둥에 맞게 안전하고 빠르게 운영하도록 돕는다.**
> 6대 기둥: 운영 우수성 · 보안 · 안정성 · 성능 효율성 · 비용 최적화 · 지속가능성.
> 다양한 데이터소스와 에이전트로 **6대 기둥 관점의 진단과 해결방법 제시**를 제공하여 운영을 지속 고도화한다.

"안전하게"는 목표의 일부 → 지금까지의 read-only 번복은 "후퇴"가 아니라 **"안전을 위한 실행 경로 게이팅"**으로 재해석.

### 가치
- **단일 창에서 6대 기둥을 본다** — 인벤토리·토폴로지(안정성), 비용(비용최적화), 보안/CIS(보안), 메트릭(성능), 진단(운영우수성).
- **진단을 넘어 해결까지** — 라이브 데이터(AWS+외부 관측성)+에이전트로 근본원인 + *고치는 법*까지 제시.
- **안전 내장** — 빠르게 운영하되 위험한 실행은 통제·게이트·승인 뒤. 프로덕션 안전.

### 핵심 설계 — 4축
1. 모든 기능·진단은 **6대 기둥 중 하나 이상에 매핑**된다 (새 결정 정당성 = 어느 기둥 개선).
2. 운영의 현재 형태 = **진단 + 해결방법 제시**. 실행은 안전 게이트 뒤.
3. **Terraform MSA** — 비공개 엣지 · Aurora · thin-BFF + 비동기 워커 · AgentCore 섹션 에이전트 · 외부 데이터소스/통합.
4. **모든 신기능 flag-gated** — 기본 OFF, 단계적 활성화.

### 실행/자동화의 위상 — **점진적 실행 (게이트된 로드맵)**
- 최종 목표는 안전한 실행/자동화 포함.
- **현재는 "진단+제시"만 ON.** AWS 리소스 변경·자율 조치는 **"영구 금지"가 아니라 "아직 안 켬"** — 안전조건(human-gate·per-action IAM·감사·flag 승인) 충족 전 OFF.
- 외부 DATA write(비-AWS 기록/메시지)는 거버넌스 하 이미 허용 — 리소스 변경과 구분.
- → 옛 ADR의 `do-not-enable 영구 동결`은 BASELINE에서 **로드맵 게이트**로 재서술.

## 3. 프로그램 (3 Phase)

### Phase 1 — 현실 감사 (토대, **리포트 먼저**)
3자 대조: **문서(ADR/reference/architecture) ↔ 코드/terraform flag/state ↔ 배포 현실**.
- 근거 깊이 = **정적 대조 + 라이브 프로빙**: 정적 대조로 drift/갭을 잡고, 배포된 앱의 주요 경로(헬스·페이지·챗·진단·핵심 API)를 실제 구동/프로빙하여 "테스트 시 터지는" 런타임 버그를 잡는다.
- **컴포넌트별 병렬 서브에이전트 fan-out**: 엣지·인증·데이터·web-BFF·agentcore·워커·eks + V1→V2 기능 패리티. 각 에이전트가 구조화 리포트 반환 → Claude가 종합.
- 산출 = **단일 감사 리포트** `docs/reviews/2026-06-21-docs-reality-audit.md`:
  - **Drift 맵** (문서 X ↔ 실제 Y, 어느 쪽이 맞는지 판정)
  - **V1→V2 갭** (미구현/오구현, 06-10 감사 갱신·확장)
  - 각 항목 6기둥 태그 + 우선순위(P0~P3)
- **게이트:** owner가 리포트를 검토·승인한 뒤 Phase 2/3 진행.

### Phase 2 — 정리 (BASELINE + docs IA 재정비)
Phase 1의 확정된 진실로:
- **`docs/decisions/BASELINE.md`** 작성 (구조 §4).
- **옛 ADR 001~045 + .template.md → `docs/decisions/archive/`** (`git mv`, 내용 불변) + `archive/README.md`.
- **docs/ IA 재정비** (§5 목표 구조).
- **CLAUDE.md 3곳**(루트·docs/·docs/decisions/) 모순 문단 제거 → BASELINE/reference 가리킴.
- **stale 설계문서 현행화/폐기** (architecture.md → reference/README.md 재작성 등).
- **BASELINE §1/§2 확정 전 멀티-AI 패널 교차검증** (누락·오분류 방지).

### Phase 3 — 갭 백로그
Phase 1 미구현/오구현 → 6기둥 매핑 + 우선순위 백로그(`docs/plans/` active). 즉시 수정 or 추적. (실제 코드 수정은 별도 승인 후.)

## 4. `BASELINE.md` 구조

AI와 모든 CLAUDE.md가 **이것만** 현행 진실로 읽는다. 한/영 병기.

| 섹션 | 내용 | 규칙 |
|---|---|---|
| **§0 북극성** | 위 2장 그대로 | 고정. owner 승인 시만 변경. |
| **§1 살아있는 결정** | 현행 동작을 토픽별 한 줄씩 (엣지/인증, 데이터, AI진단, 챗 라우팅, 외부통합, 워커, EKS, 멀티계정, 비용 …). 가능하면 6기둥 태그. | 줄 끝 `(why: ADR-0xx)` 포인터만. 번복 체인·조건부 조항 금지. |
| **§2 로드맵 게이트** | 아직 OFF인 것. 각 항목 `[무엇] + [켜는 안전조건]`. terraform flag description이 1차 원천. | "영구 금지" 표현 금지. 조건 명시 필수. |
| **§3 불변식/용어** | read-only 정의, 6기둥 매핑 규칙, flag 규율 | 결정론적 판정 기준. |

§2 예시:
- `AWS 리소스 변경(SSM/Change Manager) — OFF (remediation_enabled). 켜는 조건: human-gate + per-action IAM + 완전 감사 + owner 승인. (why: ADR-029/036)`
- `자율 mitigation/인시던트 자동조치 — OFF (incident_lifecycle_enabled=analysis-only). 켜는 조건: 점진 실행 검증 + flag. (why: ADR-032/035)`
- `외부 DATA write(Slack/Notion/Jira) — OFF (integrations_write_enabled). 독립 control plane, no-AWS-mutation IAM. (why: ADR-040/041)`
- `BYO-MCP(임의 외부 MCP) — 폐기. 큐레이션 커넥터만. (why: ADR-031-P3/041)`

## 5. docs/ 목표 IA

원칙: **현행 진실(항상 정확) 과 역사/과정(보존, 안 읽음)을 물리 분리.**

```
docs/
├── README.md                  # docs 지도(사람용)
├── CLAUDE.md                  # AI 안내: 현행 진실 = decisions/BASELINE.md + reference/
│
│   ── 현행 진실 ──
├── decisions/
│   ├── BASELINE.md
│   ├── CLAUDE.md              # 짧은 포인터
│   └── archive/              # 옛 ADR 001-045 + template (동결) + README
├── reference/                 # 현행 설계, 컴포넌트당 1파일 (superpowers/reference 승격)
│   ├── README.md             # v2 시스템 개요 (낡은 architecture.md 대체)
│   └── 01..07-*.md
│
│   ── 운영 가이드 ──
├── guides/                    # install · onboarding · troubleshooting · ai-testing
├── runbooks/                  # (유지)
│
│   ── active 작업공간 ──
├── specs/                     # 진행 중 신규 설계(spec). LIVE 후 history로 sweep.
├── plans/                     # 진행 중 구현 계획. LIVE 후 history로 sweep.
│
│   ── 역사/과정 (보존, 안 읽음) ──
├── history/
│   └── specs/  plans/  reviews/  brainstorm/  archive/
│
│   ── 기타 ──
├── brochure/                  # (유지, 마케팅 소스)
└── AGENTS.md · GEMINI.md      # co-agent 컨텍스트 (유지)
```

이동 요지:
- **설계 단일화** — architecture.md(v1) 폐기 → reference/README.md(v2 개요) 재작성; superpowers/reference 7개 → docs/reference 승격.
- **active vs history 이분법** — 신규 spec/plan은 docs/specs·docs/plans(active)에 쓰고, 기능이 LIVE 배포/병합되면 docs/history로 sweep. superpowers/ 경로는 은퇴(스킬 기본값은 설정으로 docs/specs·docs/plans 재지정).
- **역사 격리** — superpowers/{specs,plans,archive} + plans/ + reviews/ + brainstorm/ → docs/history/. 어느 게 "완료"라 옮길지는 Phase 1 감사가 판정.
- **가이드 묶음** — 흩어진 운영문서 → guides/.

## 6. §1·§2 추출/정확성 방법
- 1차: 인덱스 + 각 ADR Status + terraform `*_enabled` description으로 ADR을 `LIVE / GATED-OFF / SUPERSEDED / v1-only` 라벨링.
- 2차: Phase 1 감사 결과(코드/배포 현실)와 대조 — 문서 LIVE ↔ 코드 flag 불일치 시 **현실 우선**, 불일치는 감사 리포트에 기록.
- SUPERSEDED·v1-only → §1/§2 제외(archive에만). LIVE→§1, GATED-OFF→§2.
- 멀티-AI 패널 교차검증(BASELINE 확정 전): 누락·오분류 색출.

## 7. 비목표 (YAGNI)
- ADR 재번호(001 재작성) **안 함** — 교차참조 파손·과다 작업.
- ADR 내용 재작성·삭제 **안 함** — 그대로 동결.
- 새 거버넌스 메커니즘 도입 **안 함** — 기존 결정의 *표현/구조*만 정리.
- Phase 1/2는 코드 변경 **없음**(순수 문서·감사). 코드 수정은 Phase 3에서 별도 승인.

## 8. 검증
- BASELINE 자체 무모순: §1 어느 줄도 §2와 충돌 없음, 번복 조항 부재.
- 루트 CLAUDE.md에 "ADR-0xx…REVERSED…carve-out…" 모순 문단 잔존 없음.
- `git mv`/이동 후 `ADR-0`·`docs/decisions/0xx` 참조 미파손(grep 확인, 필요 시 일괄 치환).
- 새 세션 시뮬: BASELINE만 읽고 "AWS 변경 자동화 해도 되나?" → 결정론적 "OFF, 조건 X" 답.
- docs/ IA: 루트에서 "현행 vs 역사"가 즉시 구분됨.

## 9. 리스크
- **추출 누락** — LIVE 결정을 §1에서 빠뜨림 → §6 2차(현실 대조) + 멀티-AI로 완화.
- **동시 세션 충돌** — 다른 세션이 docs/ADR 건드리는 중 git mv 충돌 → 작업 직전 `git status`, 작은 단위 즉시 커밋, HEAD 동기화.
- **교차참조 혼선** — 절대경로 참조(`docs/decisions/0xx-*.md`) 파손 → grep 색출 후 archive 경로로 치환.
- **라이브 프로빙 부작용** — read-only 경로만 프로빙(POST/mutating 호출 금지), 진단 등 비용 유발 호출은 최소.
