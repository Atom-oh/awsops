# API 라우트 / API Routes

## 역할 / Role
Next.js App Router 기반 서버 API. 브라우저가 호출하는 모든 동적 엔드포인트는 이 디렉토리 아래의 `route.ts` 파일로 구현된다.
(All dynamic server endpoints live here as `route.ts` files under Next.js App Router.)

## 엔드포인트 매트릭스 / Endpoint Matrix (18개)
| 경로 | Method | 설명 |
|------|--------|------|
| `ai/route.ts` | POST (SSE) | 11-라우트 AI 라우터: code → network → container → iac → data → security → monitoring → cost → datasource → aws-data → general |
| `steampipe/route.ts` | POST/GET/PUT | Steampipe SQL 실행 · Cost 가용성 probe · Inventory |
| `auth/route.ts` | POST | 로그아웃 (HttpOnly Cognito 쿠키 서버 사이드 삭제) |
| `msk/route.ts` | GET | MSK 브로커 노드 + CloudWatch 메트릭 |
| `rds/route.ts` | GET | RDS 인스턴스 CloudWatch 메트릭 |
| `elasticache/route.ts` | GET | ElastiCache 노드 메트릭 |
| `opensearch/route.ts` | GET | OpenSearch 도메인 메트릭 |
| `agentcore/route.ts` | GET | AgentCore Runtime/Gateway 상태 (config 기반) |
| `code/route.ts` | POST | 코드 인터프리터 (Python sandbox) |
| `benchmark/route.ts` | GET | CIS 컴플라이언스 벤치마크 |
| `container-cost/route.ts` | GET | ECS Container Cost (CloudWatch Container Insights + Fargate) |
| `eks-container-cost/route.ts` | GET | EKS Container Cost (OpenCost + request-기반 폴백) |
| `bedrock-metrics/route.ts` | GET | Bedrock 사용량 (CloudWatch + AWSops 앱 토큰 통계) |
| `datasources/route.ts` | CRUD/POST | 외부 데이터소스 관리·쿼리·AI 쿼리 생성 (SSRF 방지) |
| `k8s/route.ts` | POST | EKS kubeconfig 등록 |
| `report/route.ts` | POST/GET | AI 종합 진단 리포트 생성 · S3 저장 · 스케줄링 |
| `alert-webhook/route.ts` | POST | 알림 웹훅 수신 (CloudWatch SNS / Alertmanager / Grafana / Generic) + HMAC + 상관 분석 트리거 |
| `notification/route.ts` | POST | Slack/웹훅 알림 발송 |

## 규칙 / Rules
- 외부 호스트로 `fetch` 시 반드시 **allowlist + SSRF 방지** (`datasource-client.ts`)
- AWS CLI 호출은 `execFileSync` 배열 인자 형태만 — 문자열 concat 금지 (shell injection)
- 민감 필드는 응답에서 마스킹 (datasources 토큰/패스워드)
- `multiAccount`이면 `accountId` 파라미터로 `buildSearchPath()` 스코핑
- 장시간 작업(reports)은 SSE 또는 비동기 job 패턴 — 요청 타임아웃 회피
- 에러 응답은 사용자 노출 문구/내부 stack 분리 — `{error: string, detail?: string}`

---

# API Routes (English)

## Role
Server endpoints invoked by the browser. All are `route.ts` files under Next.js App Router. Complete list and priorities are in the root `CLAUDE.md` AI Routing table.

## Conventions
- Outbound `fetch` to external hosts must go through the datasource allowlist with SSRF protections
- AWS CLI invocations use `execFileSync` with array args only — no string concatenation
- Sensitive fields (datasource tokens, passwords) must be masked in responses
- Multi-account requests set `accountId`; queries go through `buildSearchPath()`
- Long-running work (report generation) uses SSE or async job patterns, never blocking on a single request
- Error responses separate user-safe `error` from internal `detail`
