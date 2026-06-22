# Documentation

프로젝트 문서의 목적별 분류. 각 디렉토리의 자체 CLAUDE.md 를 참고.
Project documentation organized by purpose. Each subdirectory has its own CLAUDE.md.

## 구조 / Structure — 현행 진실 vs 역사 분리

**현행 진실 (CURRENT — 항상 정확히 유지):**
| 디렉토리 / Directory | 용도 / Purpose |
|---|---|
| [decisions/BASELINE.md](decisions/BASELINE.md) | **결정의 단일 현행 진실** (북극성+불변식+동결register+14 ADR 인덱스) — 여기부터 |
| [decisions/](decisions/) | 통합 ADR `0NN-*.md`(현행 결정 상세) + BASELINE + CLAUDE |
| [reference/](reference/) | v2 컴포넌트별 현행 설계 (README=개요, 01~07) / current design, one file per component |

**운영 가이드 (OPERATOR):**
| [guides/](guides/) | install · onboarding · troubleshooting · ai-testing |
| [runbooks/](runbooks/) | 운영 시나리오별 대응 가이드 |

**진행 중 (ACTIVE):**
| [specs/](specs/) · [plans/](plans/) | 진행 중 설계/계획. 완료(LIVE+reference 증류) 시 history로 sweep |

**역사 (HISTORY — 보존, 명시 요청 없이는 읽지 않음):**
| [history/](history/) | 옛 specs/plans/reviews/brainstorm/archive + `ADR-MAPPING.md`(옛 ADR↔새 ADR) + architecture-v1.md |
| (옛 ADR 본문) | 트리에 없음 — git tag `adr-legacy-2026-06-22` (복원: `git show <tag>:docs/decisions/0NN-*.md`) |

## 문서 규칙 / Conventions
- 모든 신규 문서는 **한국어/영어 병기**
- **결정은 BASELINE이 단일 진실** — 새 ADR = `decisions/` 최고번호+1(현재 **014**), single Status, **같은 PR에서 BASELINE §3 갱신 필수**(anti-drift)
- ADR 파일명: `NNN-kebab-case-title.md`
- 현행 진실(decisions/BASELINE+reference)과 history를 섞지 않는다. 옛 ADR 본문/history는 명시 요청 시에만 읽는다.
- 런북은 `docs/runbooks/CLAUDE.md` 규칙 준수

## 문서 관련 스킬 / Related Skills
- `/sync-docs` — CLAUDE.md 자동 동기화
- `/project-init:add-adr` — 새 ADR 생성
- `/project-init:add-runbook` — 새 런북 생성
- `/project-init:health-check` — 문서 커버리지 검증
