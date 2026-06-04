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
| 001 | Steampipe pg Pool (CLI 배제) | Accepted — v2 호스트 위치는 030이 승계 (pg Pool 결정 유효) |
| 002 | AI 하이브리드 라우팅 | Accepted — 라우트 4→11 확장 (현황은 011/016/025) |
| 003 | SCP 차단 컬럼 처리 | Accepted |
| 004 | Gateway 역할 분리 | Accepted — 게이트웨이 수 7→8 정정 |
| 005 | VPC Lambda → Steampipe 접근 | Accepted — v2 네트워킹 경로는 030이 승계 |
| 006 | Cost 가용성 Probe | Accepted |
| 007 | 리소스 인벤토리 베이스라인 | Accepted |
| 008 | 멀티 어카운트 지원 | Accepted |
| 009 | 알림 트리거 AI 진단 | Accepted (2026-04-22) — supersession proposed by 032 (상관분석 엔진은 032 Triage로 이월) |
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
| 024 | CDK 3-Stack 분할 (Awsops/Cognito/AgentCore) | Accepted (2026-04-22) — v2 인프라는 030이 승계, Lambda 수 20 |
| 025 | 멀티 라우트 병렬 Synthesis | Accepted (2026-04-22) |
| 026 | i18n LanguageProvider | Accepted (2026-04-22) |
| 027 | Code Interpreter 세션 격리 | Accepted (2026-04-22) |
| 028 | CloudFront CACHING_DISABLED | Accepted (2026-04-22) |
| 029 | 변경 작업 프레임워크 (ADR-010 Phase 3 게이트) | Proposed (2026-04-26) |
| 030 | ECS Fargate 워크로드 + Aurora 앱 상태 + 이중 ECR | Accepted (2026-05-27) |
| 031 | 런타임 커스터마이즈 에이전트·스킬 (관리자 구성 Agent Space + BYO-MCP) | Proposed (2026-05-31) |
| 032 | 이벤트 트리거 자율 인시던트 라이프사이클 (멀티 에이전트 Lead/Sub) | Proposed (2026-05-31) |
| 033 | AIOps LLM 비용 최적화 (Haiku 분류·프롬프트 캐싱·응답 캐시·토큰 예산) | Proposed (2026-06-01) |
| 034 | 알림 자동 RCA 라이트백 (OpsCenter/Incident Manager 양방향 보강) | Proposed (2026-06-01) |
| 035 | K8sGPT 하이브리드 (MCP로 AgentCore에 통합하는 인클러스터 K8s 진단, Haiku 4.5) | Proposed (2026-06-04) |

## 새 ADR 추가 / Adding a New ADR
1. 번호: `ls docs/decisions/*.md | tail -1` 로 최신 번호 확인 후 +1
2. `.template.md` 를 복사하여 시작
3. Status 는 `Proposed` 로 시작 — 결정 확정 시 `Accepted (YYYY-MM-DD)` 로 변경
4. 이 인덱스에 한 줄 추가

## 관련 스킬 / Related Skill
- `/project-init:add-adr` — 자동 번호로 새 ADR 생성
