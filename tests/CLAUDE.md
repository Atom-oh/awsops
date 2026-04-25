# 테스트 모듈 / Tests Module

## 역할 / Role
프로젝트 테스트 스위트. Bash 기반 구조/훅 테스트 + TypeScript 유닛 테스트 병행.
(Project test suite. Bash-based structure/hook tests plus TypeScript unit tests.)

## 구조 / Layout
| 경로 | 대상 | 실행기 |
|------|------|--------|
| `tests/unit/*.test.ts` | `src/lib/` 알림 로직 (correlation, knowledge, types, webhook), CDK 알림 인프라 | `npm test` (ts-node / jest) |
| `tests/hooks/test-*.sh` | `.claude/hooks/` 훅 스크립트 동작·시크릿 패턴 | `bash tests/run-all.sh` |
| `tests/structure/test-*.sh` | 에이전트 계약, 플러그인 구조 | `bash tests/run-all.sh` |
| `tests/fixtures/` | 시크릿 샘플, 거짓 양성 샘플 | 훅/시크릿 테스트에서 로드 |

## 실행 / Running
```bash
bash tests/run-all.sh    # 전체 (TAP 포맷, 훅+구조)
npm test                 # 유닛 테스트 (ts)
```

## 규칙 / Rules
- 출력은 TAP v13 — `ok N - desc` / `not ok N - desc`
- 새 훅 추가 시 `tests/hooks/`에 대응 테스트 파일 생성 (`test-<hook>.sh`)
- 유닛 테스트 파일명: `<module>.test.ts`, `src/lib/<module>.ts`와 1:1 매핑
- 시크릿 탐지 테스트: `tests/fixtures/secret-samples.txt`에 양성, `false-positives.txt`에 음성 케이스 추가
- 통합 테스트는 실제 Steampipe/AgentCore에 붙이지 말 것 — 픽스처/모킹 사용
- CI 훅 실패 시 우회 금지(`--no-verify` 사용 금지) — 근본 원인 수정
