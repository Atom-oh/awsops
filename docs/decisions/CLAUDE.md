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
| 009 | 알림 트리거 AI 진단 | Superseded by 032 (2026-06-09) — 032 Accepted; 상관분석 엔진은 032 Triage로 보존·이월 (원안 Accepted 2026-04-22) |
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
| 024 | CDK 3-Stack 분할 (Awsops/Cognito/AgentCore) | **Superseded by 037 (2026-06-10)** for v2 (CDK 폐기 → Terraform) — Accepted as v1 history, Lambda 수 20 |
| 025 | 멀티 라우트 병렬 Synthesis | Accepted (2026-04-22) |
| 026 | i18n LanguageProvider | Accepted (2026-04-22) |
| 027 | Code Interpreter 세션 격리 | Accepted (2026-04-22) |
| 028 | CloudFront CACHING_DISABLED | Accepted (2026-04-22) |
| 029 | 변경 작업 프레임워크 (ADR-010 Phase 3 게이트) | Accepted (2026-06-09) — 멀티AI 합의(REVISE×2/AWC×1) 반영 개정; 메커니즘은 036 하이브리드로 위임, v2(Terraform/Fargate/Aurora) 현행화·기술 정정, 6대 통제 유지 |
| 030 | ECS Fargate 워크로드 + Aurora 앱 상태 + 이중 ECR | Accepted (2026-05-27) — **메커니즘(4-컨테이너/Service Connect Steampipe/CDK)은 037이 정제·부분 승계**; Aurora·이중 ECR 의도는 유효 |
| 031 | 런타임 커스터마이즈 에이전트·스킬 (관리자 구성 Agent Space + BYO-MCP) | Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); mutating BYO-MCP 거버넌스 경유·revocation fail-closed·BYO-MCP 하드닝·인젝션 가드 보완 |
| 032 | 이벤트 트리거 자율 인시던트 라이프사이클 (멀티 에이전트 Lead/Sub) | Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); 034/036 관계·P2 실행 바인딩·look-back 설정값화·Lead 최소권한 보완 |
| 033 | AIOps LLM 비용 최적화 (Haiku 분류·프롬프트 캐싱·응답 캐시·토큰 예산) | Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); 프롬프트 캐싱 범위 정정(게이트웨이 호출 불투명)·sourceDataFingerprint·예산 영속 보완; Phase 2 (Aurora durable budget) 구현, 의미 캐시는 v2 AI 라우트 동반 후속 페이즈로 연기 |
| 034 | 알림 자동 RCA 라이트백 (OpsCenter/Incident Manager 양방향 보강) | Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); 피드백루프 차단 메커니즘·observability-write 통제 부분집합·best-effort 보완 |
| 035 | K8sGPT 하이브리드 (MCP로 AgentCore에 통합하는 인클러스터 K8s 진단, Haiku 4.5) | Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); Rule 5 강화 + 7~11 추가 |
| 036 | 변경·조치 실행 substrate (SSM Automation + Change Manager × P2 워커 백본 하이브리드) | Accepted (2026-06-09) — 멀티AI 합의 리뷰(ACCEPT-WITH-CHANGES); `.sync` 사실오류 정정·완료추적·승인주체·per-action IAM·통제 매핑 보완 |
| 037 | v2 파운데이션 — Terraform + thin-BFF 웹 + 비동기 워커 (CDK 폐기) | Accepted (2026-06-10) — co-agent ADR 일관성 리뷰; 024 전면 승계 + 030 메커니즘 정제(Steampipe 라이브 없음·flag-gated 인벤토리 sync 확정) |
| 038 | 하이브리드 에이전트 라우팅 (정규식+Haiku 분류기) + v2 프롬프트 캐싱 | Accepted (2026-06-10) — 멀티AI 의사결정(A-now/C-at-P4 만장일치) + 스펙 리뷰 8건 반영; Gateway 시맨틱 P4 연기; **활성화 LIVE (2026-06-10): 게이트 hybrid 96.9% (+27.7pp) PASSED·캐싱 GREEN·분류기 타임아웃 3.5s 정정** |

## 새 ADR 추가 / Adding a New ADR
1. 번호: `ls docs/decisions/*.md | tail -1` 로 최신 번호 확인 후 +1
2. `.template.md` 를 복사하여 시작
3. Status 는 `Proposed` 로 시작 — 결정 확정 시 `Accepted (YYYY-MM-DD)` 로 변경
4. 이 인덱스에 한 줄 추가

## 관련 스킬 / Related Skill
- `/project-init:add-adr` — 자동 번호로 새 ADR 생성
