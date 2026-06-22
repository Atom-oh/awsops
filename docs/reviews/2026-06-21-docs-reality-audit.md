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
> 핵심 패턴: **reference/ 7개 문서 대부분이 작성 시점(P1x snapshot)에 FROZEN** → 이후 추가된 라우트·테이블·게이트웨이·기능이 전면 DRIFT. 코드 자체는 대체로 건강. ✓V = chair가 file:line 재확인.

### B1 엣지/네트워크 _(검증 완료)_
핵심축(VPC Origin https-only, 내부 ALB HTTPS:443 리전 ACM, ALB SG가 CF 관리형 SG에서 443, create_network 분기, SG desc 불변) 모두 **LIVE**. 결함 2:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| edge-05 | DRIFT ✓V | TG health `/awsops/healthz` (01:33) | `workload.tf:437 /api/health` (컨테이너도 :331 /api/health) | P2 (문서오류, 코드정상) |
| edge-09 | DRIFT | 신규VPC 기본 CIDR `10.30.0.0/16` (01:39) | `variables.tf:23 = 10.20.0.0/16` | P3 (문서오기, live는 reuse) |

### B2 인증 _(검증 완료)_
코드는 핵심축(USER_PASSWORD_AUTH, id_token 12h, `/login` 리다이렉트, RS256 JWKS, PKCE 다크폴백) **일치**. **문서 전체가 ADR-042 인앱 로그인 전환 이전(Hosted-UI-1차) 모델에 동결** → 광범위 DRIFT:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| auth-06 | MISSING(doc) | 인앱 `/login`+USER_PASSWORD_AUTH 전무 | `login/page.tsx`, `api/auth/login/route.ts`, `lib/login.ts:42`, `auth.tf:36` | P1 |
| auth-07 | DRIFT | 미인증→Cognito `/login` (02:36) | `py.tftpl:100 → 자체 /login` | P2 |
| auth-08 | DRIFT | `awsops_token` 1h (02:21) | 12h (`py.tftpl:176`, `auth.tf:37`) | P2 |
| auth-09 | DRIFT | 공개경로 2개 (02:18) | py.tftpl:22 추가 signout/login/api-login/icon/webhook | P2 |
| auth-13 | SUPERSEDED | Purpose=Hosted-UI 1차 | 실제 인앱폼 1차, Hosted UI 다크폴백 | P1 |

### B3 데이터/Aurora _(검증 완료)_
핵심축(PG17.9, 0.5–4 ACU, KMS CMK, RDS master secret, node-pg, ULID 마이그레이션, schema_migrations) 모두 **LIVE/MATCH**. DRIFT 2:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| data-06 | DRIFT ✓V | ADR-030 7-table schema | `schema.sql CREATE TABLE = 30개`, baseline v9 | P1 (테이블 수 미갱신) |
| data-14 | DRIFT | Purpose=v1 JSON 치환만 | 스키마가 agents/remediation/incidents/k8s/chat 신규 도메인 다수 | P2 |
비고: RDS Data API(`data.tf:58 enable_http_endpoint`) 문서 미기재(MISSING-doc).

### B4 web/BFF _(검증 완료)_
문서화된 5개 라우트(health/stream/db/jobs/jobs[id])는 전부 **LIVE·정합**. 그러나 thin-BFF 시점에 동결되어 대규모 DRIFT:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| web-08 | DRIFT ✓V | `/api/*` 4개 | **실제 24개** (accounts,actions,ai-usage,auth,bedrock-metrics,chat,compliance,cost,customization,datasources,diagnosis,eks,graph,incidents,integrations,inventory,me,opencost,overview,security…) | P1 |
| web-09/10/11 | DRIFT | 페이지·핵심 lib(auth/jobs/http-body)·redirects 미기재 | 다수 page.tsx(전부 export default), `lib/{auth,jobs,http-body}` | P2 |
| web-12 | SUPERSEDED | "deliberately thin, P1d" | chat/compliance/diagnosis/eks/cost/datasources 풀스택 BFF로 확장 | P1 |

### B5 AgentCore _(검증 완료)_
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| agentcore-01 | **DRIFT ✓V** | "EXACTLY 8 / external-obs는 9th 아님"(05:22-25,61) ↔ 문서 타 위치 "9"(05:31,38,74,90) | `agent.py:339=8 라우트` · `catalog.py:18=9(external-obs 포함)` · `provision.py:5=9 프로비저닝`. **net: 9 게이트웨이 프로비저닝 / 8 에이전트 라우트.** 문서 자기모순 | **P0 (독트린↔코드, 메모리 C1/C9)** |
| agentcore-02 | SUPERSEDED ✓V | README.md:62 + 05:111 "OpenCost install button (ADR-029 mutating)" | 번복됐는데 두 문서에 잔존 | P1 (번복 잔재) |
| agentcore-03 | DRIFT | "배포=2 슬라이스(iam14,flow1), 함대=P3"(05:32-34) | `ai.tf` ~18 lambda + integ 6, `catalog.py` ~25 target — 함대 대부분 착륙 | P1 (대폭 과소기재) |
| agentcore-04/05/06 | LIVE | SSM SoT·agentcore_enabled 게이트·Memory 365 | `ai.tf:306,61`, `provision.py:164` | — |

### B6 워커 _(검증 완료)_
핵심축(workers_enabled 게이트, ledger-first, dispatcher 멱등, SFN $.runtime Choice, Catch→status_updater failed, reaper 5min, Fargate CMD, ESM kill-switch, SG reuse) 모두 **LIVE/MATCH**. 문서가 P2(noop only) 동결 → 신규 미반영:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| worker-19 | SUPERSEDED | "P2 noop/noop-heavy only, real ops P3+" | report/compliance/remediation(action)/incident_stage 전부 배선 | P1 |
| worker-04 | DRIFT | type-guard registry-only | dispatcher.py:30-70 action/incident_stage를 별도 SM으로 분기(레지스트리 검사 전) | P1 |
| worker-07/08 | DRIFT | "4 Lambda / noop만" | 실제 6 lambda(+ai_cost_aggregator,+schedule_dispatcher), REGISTRY에 report/compliance | P2 |
| worker-17/18 | DRIFT | 미언급 | schedule_dispatcher(hourly report), ai_cost_aggregator(6h) 신규 | P2 |
| worker-10 | DRIFT | reaper=worker_jobs만 | reaper도 remediation/diagnosis_reports 보정 | P2 |

### B7 EKS _(검증 완료)_
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| eks-02 | **DRIFT ✓V** | web_view = `AmazonEKSViewPolicy`(07:18,48,52) | `eks.tf:34 = AmazonEKSAdminViewPolicy`(web), agent role=View(eks.tf:46) | P1 (load-bearing 오류) |
| eks-04/05/06/07/08 | DRIFT/MISSING | "kubeconfig 자동등록·K8s UI = P3 연기" | 이미 LIVE: in-cluster read(`eks-incluster.ts`), runtime register(env∪DB `eks-registry.ts`), `eks_auto_register_enabled`, K8sGPT(`k8sgpt_enabled` GATED-OFF) 전부 문서 누락 | P1 |
| eks-11 | SUPERSEDED | "EKS ADR 없음(gap)" | ADR-035가 in-cluster 진단 관할 | P2 |
| eks-10 | PARTIAL | OpenCost=ADR-029 mutating 버튼(P3) | 실제 out-of-band install 번들 생성(read-only, 사용자 실행) — 번복 정합 | P2 |

### B8 AI 진단/챗 (cross-cutting) _(Task 9)_

## C. V1→V2 기능 갭 (미구현/오구현) _(Task 8)_

## D. terraform *_enabled 교차검증 _(Task 11)_

## E. 종합 — 우선순위 · BASELINE 매핑 · self-contradiction 체크 _(Task 12)_
