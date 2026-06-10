# Documentation

프로젝트 문서의 목적별 분류. 각 디렉토리의 자체 CLAUDE.md 를 참고.
Project documentation organized by purpose. Each subdirectory has its own CLAUDE.md.

## 구조 / Structure

| 디렉토리 / Directory | 용도 / Purpose |
|---|---|
| [architecture.md](architecture.md) | 시스템 아키텍처 (단일 파일) |
| [onboarding.md](onboarding.md) | 신규 팀원 온보딩 |
| [INSTALL_GUIDE.md](INSTALL_GUIDE.md) | 설치 가이드 (11단계) |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 일반 트러블슈팅 모음 |
| [decisions/](decisions/) | ADR (Architecture Decision Records), 001~037 |
| [runbooks/](runbooks/) | 운영 시나리오별 대응 가이드 |
| [reviews/](reviews/) | 코드 리뷰 / 교차 리뷰 결과 |
| [plans/](plans/) | 기능 설계/기획 문서 |
| [superpowers/reference/](superpowers/reference/) | v2 컴포넌트별 현행 설계 레퍼런스 (컴포넌트당 단일 출처) / current v2 design, one file per component |
| [superpowers/archive/](superpowers/archive/) | v2 설계문서 실행 이력 (reference/로 대체됨) / archived v2 specs+plans, superseded by reference/ |
| AI_TEST_*.md | AI 어시스턴트 테스트 질문셋 |
| TEST-COVERAGE-PLAN.md | 테스트 커버리지 계획 |

## 문서 규칙 / Conventions
- 모든 신규 문서는 **한국어/영어 병기**
- ADR 번호는 `docs/decisions/` 의 최고 번호 + 1 (현재 037)
- ADR 파일명: `NNN-kebab-case-title.md`
- 런북은 `docs/runbooks/CLAUDE.md` 규칙 준수

## 문서 관련 스킬 / Related Skills
- `/sync-docs` — CLAUDE.md 자동 동기화
- `/project-init:add-adr` — 새 ADR 생성
- `/project-init:add-runbook` — 새 런북 생성
- `/project-init:health-check` — 문서 커버리지 검증
