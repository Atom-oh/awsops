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
| 001 | Steampipe pg Pool (CLI 배제) | Accepted |
| 002 | AI 하이브리드 라우팅 | Accepted |
| 003 | SCP 차단 컬럼 처리 | Accepted |
| 004 | Gateway 역할 분리 | Accepted |
| 005 | VPC Lambda → Steampipe 접근 | Accepted |
| 006 | Cost 가용성 Probe | Accepted |
| 007 | 리소스 인벤토리 베이스라인 | Accepted |
| 008 | 멀티 어카운트 지원 | Accepted |
| 009 | 알림 트리거 AI 진단 | Accepted (2026-04-22) |
| 010 | 이벤트 기반 사전 스케일링 (Phase 1+2) | Accepted (2026-04-26) |
| 011 | 외부 데이터소스 통합 | Accepted (2026-04-22) |
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
| 024 | CDK 3-Stack 분할 (Awsops/Cognito/AgentCore) | Accepted (2026-04-22) |
| 025 | 멀티 라우트 병렬 Synthesis | Accepted (2026-04-22) |
| 026 | i18n LanguageProvider | Accepted (2026-04-22) |
| 027 | Code Interpreter 세션 격리 | Accepted (2026-04-22) |
| 028 | CloudFront CACHING_DISABLED | Accepted (2026-04-22) |
| 029 | 변경 작업 프레임워크 (ADR-010 Phase 3 게이트) | Proposed (2026-04-26) |

## 새 ADR 추가 / Adding a New ADR
1. 번호: `ls docs/decisions/*.md | tail -1` 로 최신 번호 확인 후 +1
2. `.template.md` 를 복사하여 시작
3. Status 는 `Proposed` 로 시작 — 결정 확정 시 `Accepted (YYYY-MM-DD)` 로 변경
4. 이 인덱스에 한 줄 추가

## 관련 스킬 / Related Skill
- `/project-init:add-adr` — 자동 번호로 새 ADR 생성
