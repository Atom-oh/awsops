# Phase 1 현실 감사 리포트 (2026-06-21)

> 대상: docs(ADR/reference/architecture) ↔ code/terraform/state ↔ 배포 현실.
> 방법: 정적 대조 + 라이브 프로빙(read-only). 모든 주장은 file:line 교차검증됨(chair).
> 산출 소비처: Phase 2 BASELINE §1/§2/§3 + 통합 ADR 001~N 클러스터 + Phase 3 갭 백로그.

## finding 스키마
| 필드 | 값 |
|---|---|
| id | <lane>-NN |
| 라벨 | LIVE/GATED-OFF/FROZEN/MISSING/MIS-IMPL/DRIFT/SUPERSEDED/v1-only |
| 문서 says | <doc:line> |
| 실제 | <file:line 또는 probe 결과> |
| verdict | 일치 / drift(어느쪽 맞음) / 미구현 / 오구현 |
| pillar | <WA 기둥> |
| priority | P0/P1/P2/P3 |
| BASELINE | §2(동결/게이트) / §3(결정인덱스) / 제외(archive) |

## A. ADR 라벨 대조 + 3분류 + 병합 클러스터 (001~046)
_(Task 10)_

## B. 컴포넌트 Drift
### B1 엣지/네트워크 _(Task 1)_
### B2 인증 _(Task 2)_
### B3 데이터/Aurora _(Task 3)_
### B4 web/BFF _(Task 4)_
### B5 AgentCore _(Task 5)_
### B6 워커 _(Task 6)_
### B7 EKS _(Task 7)_
### B8 AI 진단/챗 (cross-cutting) _(Task 9)_

## C. V1→V2 기능 갭 (미구현/오구현) _(Task 8)_

## D. terraform *_enabled 교차검증 _(Task 11)_

## E. 종합 — 우선순위 · BASELINE 매핑 · self-contradiction 체크 _(Task 12)_
