# Phase 2 — 통합·정리 (BASELINE + 통합 ADR + docs IA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Phase 1 감사 리포트(`docs/reviews/2026-06-21-docs-reality-audit.md`)의 확정 진실로, 단일 `BASELINE.md` + 소수 통합 ADR(001~N) + LEGACY archive + 현행/역사 분리 docs IA를 구축한다. 코드 변경 0(문서만).

**Architecture:** 옵션 Y — 진짜 결정을 9 클러스터 + 잔여 토픽 흡수로 **새 통합 ADR ~12~15개**로 병합(`docs/decisions/`, 새 001부터). 옛 46개는 `docs/history/decisions-archive/LEGACY-0xx`로 동결(forward 배너+MAPPING). 046(브레인스토밍-오분류)은 `history/brainstorm/`로. BASELINE = 북극성+불변식+동결/게이트 register+결정 인덱스. 에이전트 컨텍스트 5종을 BASELINE으로 동기화.

**Tech Stack:** Markdown · git mv(LEGACY 리네임) · path-scoped 커밋 · grep 검증 · co-agent 패널(BASELINE 확정 전 교차검증).

## Global Constraints
- **코드 변경 0.** 문서/구조만. 코드의 `ADR-0xx` 참조 일괄 renumber 금지(LEGACY-archive resolve).
- **옛 ADR 본문 불변** — forward 배너 1줄만 추가. 병합은 *새* 파일에서.
- **freeze→roadmap softening 금지** — AWS 변경·자율은 §2에서 FROZEN(재활성화=새 ADR+패널+owner-override). 외부 DATA write는 2-티어(diagnosis_notify LIVE / integrations_write GATED).
- **단일 진실 = BASELINE + reference/.** history/archive는 명시 요청 없인 안 읽음.
- **동시 세션 안전:** `git add <명시 경로>`만, `-A`/`.` 금지. 작업 직전 `git branch --show-current`=`feat/v2-architecture-design`.
- **콘텐츠 원천 = Phase 1 리포트** §A(클러스터)·§D(flag)·§B(컴포넌트 현행)·§E(매핑). 추측 금지.
- 한/영 병기.

---

### Task 1: docs/ IA 골격 + 역사 이동
**Files:** git mv only. Create dirs via moves.
**Interfaces:** Produces 새 트리 — `docs/{reference,guides,specs,plans,history}/`, `docs/history/{specs,plans,reviews,brainstorm,archive,decisions-archive}/`.

- [ ] **Step 1: reference 승격 + architecture.md 폐기 표식**
```bash
git mv docs/superpowers/reference docs/reference
git mv docs/architecture.md docs/history/architecture-v1.md   # v1 기준, reference/README.md가 대체
```
- [ ] **Step 2: 역사 디렉토리로 이동 (완료된 과정 잔여물)**
```bash
mkdir -p docs/history
git mv docs/superpowers/archive docs/history/archive
git mv docs/superpowers/specs docs/history/specs
git mv docs/superpowers/plans docs/history/plans
git mv docs/reviews docs/history/reviews
git mv docs/brainstorm docs/history/brainstorm
git mv docs/plans docs/history/plans-legacy 2>/dev/null || true   # 옛 docs/plans(1파일)
```
- [ ] **Step 3: 가이드 묶음**
```bash
mkdir -p docs/guides
git mv docs/INSTALL_GUIDE.md docs/guides/install.md
git mv docs/onboarding.md docs/guides/onboarding.md
git mv docs/TROUBLESHOOTING.md docs/guides/troubleshooting.md
git mv docs/AI_TEST_GUIDE.md docs/guides/ai-testing.md
git mv docs/AI_TEST_QUESTIONS.md docs/guides/ai-test-questions.md
git mv docs/TEST-COVERAGE-PLAN.md docs/guides/test-coverage-plan.md
git mv docs/v1-v2-gap-audit-2026-06-10.md docs/history/v1-v2-gap-audit-2026-06-10.md
```
- [ ] **Step 4: active 작업공간 생성** (Phase 1/2 산출물은 아직 active)
```bash
mkdir -p docs/specs docs/plans
git mv docs/history/specs/2026-06-21-decisions-baseline-reset-design.md docs/specs/ 2>/dev/null || true
git mv docs/history/plans/2026-06-21-phase1-reality-audit.md docs/plans/ 2>/dev/null || true
git mv docs/history/plans/2026-06-22-phase2-consolidate-baseline-adrs.md docs/plans/ 2>/dev/null || true
git mv docs/history/reviews/2026-06-21-docs-reality-audit.md docs/reviews-pending.md 2>/dev/null || true   # 리포트는 active 유지 (실제 위치는 owner 판단; 일단 docs/reviews/ 유지가 더 단순)
```
  주의: 리포트/패널 기록은 active 참조 중 → `docs/reviews/`를 history로 옮기지 말 것. Step 2의 reviews 이동은 *완료된 옛* 리뷰만; 2026-06-21 감사/패널 3종은 `docs/reviews/`에 남긴다(이동 명령에서 제외하도록 수정 후 실행).
- [ ] **Step 5: 검증 + 커밋**
Run: `ls docs/ docs/history/ docs/reference/ docs/guides/`
Expected: 새 구조 존재, reference/ 7+README, guides/ 6파일.
```bash
git add -A docs/ && git commit -m "docs(ia): Phase2 T1 — reorg docs tree (reference 승격, history 격리, guides 묶음)"
```
(주의: 이 task는 순수 move라 `git add -A docs/`가 안전하나, 타 세션 WIP가 docs/ 밖이면 무관. docs/ 내 타 세션 변경 없으면 진행.)

---

### Task 2: 옛 ADR → LEGACY archive + forward 배너 + MAPPING
**Files:** Create `docs/history/decisions-archive/` (LEGACY-001..046 + .template), `docs/history/decisions-archive/README.md`, `docs/history/decisions-archive/MAPPING.md`.
**Interfaces:** Consumes Phase1 §A(클러스터 매핑). Produces LEGACY 동결본 + old→new 매핑.

- [ ] **Step 1: 이동 + 리네임 (스크립트)**
```bash
mkdir -p docs/history/decisions-archive
for f in docs/decisions/0*.md; do
  b=$(basename "$f"); git mv "$f" "docs/history/decisions-archive/LEGACY-$b"
done
git mv docs/decisions/.template.md docs/history/decisions-archive/LEGACY.template.md 2>/dev/null || true
git mv docs/decisions/CLAUDE.md docs/history/decisions-archive/INDEX-LEGACY.md   # 옛 인덱스 보존(새 CLAUDE는 T14)
git mv docs/decisions/AGENTS.md docs/history/decisions-archive/ 2>/dev/null || true
git mv docs/decisions/GEMINI.md docs/history/decisions-archive/ 2>/dev/null || true
```
- [ ] **Step 2: 각 LEGACY 파일 상단에 forward 배너 추가**
각 `LEGACY-0NN-*.md` 최상단에 삽입(본문은 그대로):
```markdown
> ⚠️ **LEGACY — 역사 기록(동결). 현행 진실 아님.** 현행 결정은 `docs/decisions/BASELINE.md` 및 통합 ADR(`docs/decisions/0NN-*.md`) 참조. 이 파일은 provenance(언제/왜)용. 매핑: `MAPPING.md`.
```
(서브에이전트로 일괄 — 파일당 1줄 prepend, 나머지 불변.)
- [ ] **Step 3: MAPPING.md 작성** (Phase1 §A 표 기반)
`old LEGACY ADR# → new ADR# / brainstorm / superseded(병합처)` 전 46행.
- [ ] **Step 4: README.md** (decisions-archive)
"동결 역사. 새 결정 추가 금지. 현행=../../decisions/BASELINE.md. 매핑=MAPPING.md."
- [ ] **Step 5: 046 → brainstorm 재분류**
```bash
git mv docs/history/decisions-archive/LEGACY-046-*.md docs/history/brainstorm/046-devops-rca-eog-PROPOSED.md
```
(MAPPING에 "046 → brainstorm(미결정)" 기록.)
- [ ] **Step 6: 검증 + 커밋**
Run: `ls docs/decisions/ ; ls docs/history/decisions-archive/ | head ; grep -c LEGACY docs/history/decisions-archive/MAPPING.md`
Expected: `docs/decisions/`에 ADR 0개(아직)·BASELINE 없음; archive에 45 LEGACY(046 제외)+template; MAPPING 46행.
```bash
git add -A docs/decisions docs/history && git commit -m "docs(adr): Phase2 T2 — archive 001-046 as LEGACY + forward banners + MAPPING (046->brainstorm)"
```

---

### Task 3: BASELINE.md 골격 (§0 §1 §2)
**Files:** Create `docs/decisions/BASELINE.md`.
**Interfaces:** Consumes spec §2(북극성), Phase1 §D(flag register). Produces §0/§1/§2; §3는 T14에서 채움.

- [ ] **Step 1: §0 북극성** — spec `docs/specs/2026-06-21-...-design.md` §2 전문(목표 WA6기둥/가치/핵심설계4축/실행위상=점진실행·FROZEN, aspiration) 복사.
- [ ] **Step 2: §1 불변식/용어** — read-only 정의(AWS-리소스 변경+자율=동결; 외부 DATA는 거버넌스 하 허용), 6기둥 매핑 규칙, flag 규율, 크기예산(C7: index이지 소설 아님), **범위=v2; v1(CDK/EC2/Steampipe)은 명시 제외(C8)**.
- [ ] **Step 3: §2 게이트/동결 register** — Phase1 §D OFF 표 그대로:
  - `[FROZEN] AWS 리소스 변경 — remediation_enabled. 재활성화=새 ADR+패널+owner-override. (LEGACY 029/036)`
  - `[GATED] 자율 인시던트 — incident_lifecycle_enabled(analysis-only). (032)` / `rca_writeback(034)` / `k8sgpt(035)`
  - `[GATED] 외부 DATA write 2-티어 — diagnosis_notify(SNS)=LIVE / integrations_write(Slack/Notion/Jira)=OFF·거버넌스. (040/041)`
  - `[GATED] datasource_diagnosis(039/041)` / `[옵션] Neptune(043)`
- [ ] **Step 4: 커밋**
```bash
git add docs/decisions/BASELINE.md && git commit -m "docs(baseline): Phase2 T3 — BASELINE §0 north star + §1 invariants + §2 frozen/gated register"
```

---

### Task 4–12: 통합 ADR 작성 (9 클러스터, 클러스터당 1 task)
> 각 task = Phase1 §A 클러스터 1개 → 새 ADR 1개 작성(`docs/decisions/0NN-<topic>.md`). 새 번호 001부터 순차. 구조 = Status(단일·Accepted/현행)/Context/Decision/Consequences + `consolidates: LEGACY-0xx,...`. 콘텐츠는 LEGACY 본문(history/decisions-archive) + Phase1 컴포넌트 현행(§B) 근거. **single Status, 판정가능 등급(C9), 번복 체인 서술 금지(net만).**

클러스터→새 ADR (Phase1 §A):
- **T4 ADR-001 v2 파운데이션** ← LEGACY 001,005,024,030,037 (Terraform/Fargate/Aurora, CDK·라이브Steampipe 폐기)
- **T5 ADR-002 인증·로그인** ← 020,023,042 (Cognito+엣지RS256+adminEmails+인앱/login)
- **T6 ADR-003 AI 에이전트 라우팅** ← 002,025,038,044 (정규식+Haiku+교차도메인 자동합성)
- **T7 ADR-004 AgentCore 게이트웨이·런타임** ← 004,031-P1/P2,039-P1/P2,018,027 (**net=9 게이트웨이 프로비저닝/8 에이전트 라우트** 명시 — P0 agentcore-01 해소; Memory/Interpreter; BYO-MCP[P3] 제외)
- **T8 ADR-005 AWS 변경·자율 = FROZEN** ← 029,036,031-P4 (영구 동결, flag-OFF substrate 보존; 재활성화 절차)
- **T9 ADR-006 인시던트 = ANALYSIS-ONLY (GATED)** ← 009,032,034,035 (read-only triage/RCA, 자율 mitigation 폐기)
- **T10 ADR-007 외부 데이터 통합 거버넌스 (keystone)** ← 011,039,040,041 (read-only=리소스 한정; 외부read LIVE·외부write 2-티어; SSRF/Secrets/DLP/human-gate)
- **T11 ADR-008 AI 진단 파이프라인** ← 013,016,019,021,033,045 (수집기+모델선택+포맷+병렬렌더/스트리밍[ai-10 미구현 명시]+비용캐싱; raw boto3 direct)
- **T12 ADR-009 비동기 워커 백본** ← 010(재검토)*,036-substrate(참조),037-worker (SQS+SFN+Lambda/Fargate; report/compliance/incident 배선 현행)
  *주의(reconcile): Phase1에서 LEGACY-010(이벤트 사전스케일링)은 인덱스상 LIVE이나 parity-18은 v2 page MISSING. **실제 v2 미구현이면 010은 v1-only로 재라벨**하고 워커 ADR에 넣지 말 것 — T12 착수 시 `grep -rn event.scaling web/` 재확인 후 결정.

각 task 공통:
- [ ] **Step A: LEGACY 원문 읽기** — `docs/history/decisions-archive/LEGACY-0xx-*.md`(구성 번호) + Phase1 §B 해당 컴포넌트.
- [ ] **Step B: 새 ADR 작성** — `docs/decisions/0NN-<topic>.md`, 위 구조, `consolidates:` 명시, 현행 net 결정만.
- [ ] **Step C: 검증** — `grep -n "consolidates\|^## Status" docs/decisions/0NN-*.md` (단일 Status·구성 LEGACY 명시 확인).
- [ ] **Step D: 커밋** — `git add docs/decisions/0NN-*.md && git commit -m "docs(adr): Phase2 T<n> — ADR-0NN <topic> (consolidates LEGACY ...)"`

---

### Task 13: 잔여 단독결정 흡수 → 토픽 ADR
**Files:** Create 남은 `docs/decisions/0NN-*.md`.
**Interfaces:** Consumes Phase1 §A 잔여 16(003,004→T7흡수됨,006,007,008,010,012,013→T11,014,015,017,018→T7,022,026,027→T7,028). 실제 잔여(타 클러스터 미흡수): 003,006,007,008,012,014,015,017,022,026,028.

- [ ] **Step 1: 토픽 그룹핑(owner 추천=최종 12~15)** 예:
  - ADR-010 인벤토리·리소스 모델 ← 003(SCP컬럼),007(인벤토리 베이스라인) + ECS service 갭(parity-12) 참조
  - ADR-011 멀티계정 ← 008
  - ADR-012 Cost/FinOps ← 006(probe),015(FinOps MCP)
  - ADR-013 알림·통지 ← 012(SNS),022(웹훅HMAC),014(리포트 다운로드)
  - ADR-014 캐시·i18n·엣지캐싱 등 횡단 ← 017(캐시워머),026(i18n),028(CF캐싱)
- [ ] **Step 2: 각 토픽 ADR 작성**(구조 동일, consolidates 명시).
- [ ] **Step 3: 커밋** (토픽당 또는 묶음).

---

### Task 14: BASELINE §3 결정 인덱스 + decisions/CLAUDE.md
**Files:** Modify `docs/decisions/BASELINE.md`(§3), Create `docs/decisions/CLAUDE.md`.
- [ ] **Step 1: §3 인덱스** — 새 ADR 001~N 전부 한 줄(토픽·요약·6기둥·`→ 0NN`). 상세는 ADR.
- [ ] **Step 2: decisions/CLAUDE.md** — "현행=BASELINE+이 디렉토리 ADR. 역사=../history/decisions-archive. 새 ADR은 최고번호+1, 같은 PR에서 BASELINE §3 갱신 필수(C2)."
- [ ] **Step 3: 검증** — `ls docs/decisions/` (BASELINE+CLAUDE+ADR N개), `grep -c "→ 0" docs/decisions/BASELINE.md` (인덱스 행=ADR 수).
- [ ] **Step 4: 커밋.**

---

### Task 15: reference/README.md (v2 개요) + 번복 잔재 제거
**Files:** Create/rewrite `docs/reference/README.md`; fix `docs/reference/05-agentcore.md`(번복 OpenCost 줄, agentcore-02), `docs/reference/README.md`(있으면) OpenCost 줄.
- [ ] **Step 1: reference/README.md** — v2 시스템 개요(엣지/인증/데이터/web/agentcore/워커/eks 한 단락씩 + 각 컴포넌트 파일 링크). 낡은 architecture.md(v1) 대체. 게이트웨이=net 9/8 라우트 정확 기술.
- [ ] **Step 2: 번복 잔재 제거** — `grep -rn "OpenCost install button\|ADR-029 mutating" docs/reference/` → 해당 줄 삭제/현행화(agentcore-02 P1).
- [ ] **Step 3: 검증** — `grep -rn "ADR-029 mutating\|OpenCost install button" docs/reference/` → 0 hits.
- [ ] **Step 4: 커밋.**
(참고: reference 7개 본문 전면 현행화는 범위 큼 → 본 task는 README 신설 + 번복잔재 제거만. 컴포넌트별 본문 refresh는 Phase 3/후속 — BASELINE §1에 "reference 본문은 점진 현행화" 명시.)

---

### Task 16: 에이전트 컨텍스트 5종 동기화
**Files:** Modify 루트 `CLAUDE.md`(ADR 문단), `docs/CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, (decisions/CLAUDE.md는 T14).
- [ ] **Step 1: 루트 CLAUDE.md** — 거대한 `## ADR` 모순 문단을 **삭제** → "결정 현행 진실 = `docs/decisions/BASELINE.md`(+통합 ADR). 역사=`docs/history/decisions-archive/`(LEGACY). 새 ADR=최고번호+1, 같은 PR BASELINE 갱신." 로 교체. 본문 내 FROZEN invariant 서술이 BASELINE §2와 일치하는지 확인(softening 없음).
- [ ] **Step 2: docs/CLAUDE.md** — decisions/ 설명을 BASELINE 중심으로; reference/ 승격·guides/·history/ 반영; ADR 번호 안내 갱신.
- [ ] **Step 3: AGENTS.md + GEMINI.md** — "현행 진실=BASELINE+reference만; history/archive는 명시 요청 없인 읽지 말라"(C6).
- [ ] **Step 4: 검증** — `grep -rn "REVERSED\|carve-out\|owner-override\|DOWNGRADED" CLAUDE.md docs/CLAUDE.md AGENTS.md GEMINI.md` → 모순 체인 잔존 0(또는 BASELINE 링크만).
- [ ] **Step 5: 커밋.**

---

### Task 17: 멀티-AI 패널 교차검증 (BASELINE 확정 전, spec Phase2 게이트)
**Files:** Create `docs/reviews/2026-06-22-baseline-consolidation-panel.md`.
- [ ] **Step 1: liveness** — kiro-cli/agy/codex 프로빙(메모리: gemini 스킵).
- [ ] **Step 2: fan-out** — BASELINE.md + 통합 ADR 목록 + MAPPING을 패널에 보내 "(1) §2 동결/게이트가 LEGACY 029/036/032/034/035/040 net과 일치하는가, (2) 클러스터 병합에 누락/오분류, (3) §0 freeze invariant가 softening 안 됐는가, (4) v1/v2 범위 혼선" 질의.
- [ ] **Step 3: chair 교차검증** — 지적을 LEGACY/코드로 확인 후 BASELINE/ADR 수정.
- [ ] **Step 4: 기록 + 커밋.**

---

### Task 18: 검증 + 최종 리뷰
- [ ] **Step 1: 무모순** — `grep -rn "REVERSED\|carve-out" docs/decisions/` → 0(LEGACY 제외). §2 어느 항목도 §3과 충돌 없음(수기 확인).
- [ ] **Step 2: 참조 resolve** — `grep -rn "docs/decisions/0[0-4]" --include=*.md --include=*.tf --include=*.ts .` 로 절대경로 파손 색출 → history 경로 치환 필요분 처리(코드 description의 `ADR-0xx` 텍스트 참조는 LEGACY resolve이므로 불변).
- [ ] **Step 3: 새 세션 시뮬** — BASELINE만 읽고 "AWS 변경 자동화 해도 되나?" → "FROZEN, 재활성화는 새 ADR 필요" 결정론적 답 나오는지 수기 확인.
- [ ] **Step 4: IA 확인** — `ls docs/` 루트에서 현행(decisions/reference/guides) vs 역사(history) 즉시 구분; `decisions/`엔 BASELINE+CLAUDE+ADR만.
- [ ] **Step 5: 최종 whole-branch 리뷰**(requesting-code-review code-reviewer, 가장 capable 모델) — 문서 변경 diff 전체.
- [ ] **Step 6: owner 보고 + finishing-a-development-branch.**

## Self-Review (작성자 체크)
- **spec 커버리지:** spec v4 §3 Phase2 전 항목(BASELINE/통합 ADR/LEGACY archive/brainstorm 재분류/IA/컨텍스트5종/reference 재작성/패널) → T1~T18 매핑. ✅
- **placeholder:** 각 task에 대상 파일·명령·커밋 명시. ADR 본문 자체는 LEGACY+§B에서 작성(원천 명시). ✅
- **일관성:** 새 번호 001~N, LEGACY-0xx 네이밍, consolidates 필드 전 task 동일. ✅
- **알려진 리스크 task화:** 010 event-scaling 모순(T12 reconcile), 리포트/패널 docs/reviews 잔류(T1 Step4 주의), 번복잔재(T15). ✅

## Execution Handoff
서브에이전트 주도. T1/T2(이동·리네임)·T15/T16(현행화)은 기계적 → cheap 모델. T4~T13(ADR 작성)은 판단 → standard. T17 패널·T18 최종리뷰는 capable.
