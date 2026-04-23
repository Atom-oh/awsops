# ADR-011: External Observability Datasource Integration / 외부 관측 데이터소스 연동

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops v1.7 relied exclusively on Steampipe for data access. Steampipe is purpose-built for AWS control-plane and Kubernetes resource inventory and has excellent coverage of configuration state, but it does not ingest observability telemetry. Operations teams running AWS workloads almost always operate alongside dedicated observability platforms — Prometheus for metrics, Loki for logs, Tempo or Jaeger for traces, ClickHouse for high-volume analytics, and commercial SaaS such as Dynatrace or Datadog. Investigations routinely require cross-correlating AWS configuration (from Steampipe) with live telemetry (from these platforms).

AWSops v1.7은 데이터 접근을 Steampipe에만 의존했다. Steampipe는 AWS 제어 평면과 Kubernetes 리소스 인벤토리 조회에 특화되어 구성 상태(configuration state) 커버리지는 우수하지만, 관측 원격 측정(telemetry) 수집은 범위 밖이다. AWS 워크로드를 운영하는 팀은 대부분 전용 관측 플랫폼 — 메트릭용 Prometheus, 로그용 Loki, 추적용 Tempo/Jaeger, 대량 분석용 ClickHouse, 상용 SaaS인 Dynatrace/Datadog — 을 병행 사용하며, 장애 분석 시 AWS 구성(Steampipe)과 라이브 원격 측정을 교차 상관 분석해야 한다.

Key requirements driving this decision:

- Cross-correlate AWS resource state with external observability signals in a single AI-assisted workflow.
- Accept user-supplied endpoints (the dashboard is deployed per-customer, so the set of datasources is not known at build time).
- Support multiple query DSLs (PromQL, LogQL, TraceQL, SQL) without forcing users to learn each one.
- Stay safe against SSRF when the dashboard itself runs inside a private VPC alongside EC2 metadata and internal services.

이 결정을 이끈 주요 요구사항: AWS 리소스 상태와 외부 관측 신호를 단일 AI 워크플로에서 교차 상관; 사용자 제공 엔드포인트 수용(배포별로 데이터소스 집합이 다름); 다중 쿼리 DSL(PromQL/LogQL/TraceQL/SQL) 지원; 대시보드가 Private VPC에서 EC2 메타데이터 및 내부 서비스와 함께 실행될 때 SSRF 방어.

## Decision / 결정

### Datasource Client Layer (`src/lib/datasource-*.ts`) / 데이터소스 클라이언트 계층

A new client layer sits alongside `steampipe.ts` and exposes a uniform interface over seven external platforms. `datasource-registry.ts` holds per-type metadata (health-check endpoint path, query language identifier, supported auth modes). `datasource-client.ts` performs the HTTP calls with redirect following disabled, DNS resolution before the request, and an SSRF allowlist check. `datasource-prompts.ts` carries the natural-language-to-DSL prompt for each platform.

`steampipe.ts` 옆에 신설된 클라이언트 계층이 7개 외부 플랫폼에 대해 균일한 인터페이스를 노출한다. `datasource-registry.ts`는 플랫폼별 메타데이터(헬스체크 엔드포인트, 쿼리 언어 식별자, 지원 인증 방식)를 보관하고, `datasource-client.ts`는 리다이렉트 비활성 + 요청 전 DNS 해석 + SSRF allowlist 검사를 거쳐 HTTP 호출을 수행한다. `datasource-prompts.ts`는 플랫폼별 자연어-DSL 변환 프롬프트를 담는다.

### SSRF Protection / SSRF 방어

`datasource-client.ts` resolves the target hostname before issuing the request and compares the result against a blocklist: IPv4 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, and IPv6 `::1`, `fc00::/7`, `fe80::/10`. HTTP redirects are disabled (`redirect: 'manual'`) so that a public hostname cannot trick the client into following a 302 to the metadata service. A per-account `features.allowPrivateDatasource` feature flag in `data/config.json` opens the private CIDRs for deployments where observability platforms legitimately live inside the same VPC.

`datasource-client.ts`는 요청 전에 대상 호스트명을 해석하여 IPv4 `10/8, 172.16/12, 192.168/16, 169.254/16` 및 IPv6 `::1, fc00::/7, fe80::/10` 블록리스트와 대조한다. HTTP 리다이렉트는 비활성화(`redirect: 'manual'`)하여 공개 호스트명이 302로 메타데이터 서비스로 우회하지 못하도록 한다. 관측 플랫폼이 동일 VPC 내에 합법적으로 존재하는 배포를 위해 `data/config.json`의 계정별 `features.allowPrivateDatasource` 플래그로 사설 CIDR을 개방할 수 있다.

### API + UI / API와 UI

`src/app/api/datasources/route.ts` handles CRUD, query execution, and AI query generation. Admin membership (matched against `adminEmails` in `data/config.json`) is required for create/update/delete. GET responses mask tokens with `***` so credentials never reach the browser. `src/app/datasources/page.tsx` manages the datasource inventory and `src/app/datasources/explore/page.tsx` runs ad-hoc queries.

`src/app/api/datasources/route.ts`는 CRUD, 쿼리 실행, AI 쿼리 생성을 처리한다. 생성/수정/삭제는 `data/config.json`의 `adminEmails`에 등록된 관리자만 가능하며, GET 응답은 토큰을 `***`로 마스킹하여 자격증명이 브라우저까지 도달하지 않도록 한다. `src/app/datasources/page.tsx`는 데이터소스 인벤토리를 관리하고, `src/app/datasources/explore/page.tsx`는 ad-hoc 쿼리를 실행한다.

### AI Routing / AI 라우팅

A new priority-9 `datasource` route is added to `src/app/api/ai/route.ts` between the specialized Gateway routes (2–8) and the general Steampipe `aws-data` route (10). Questions about metrics, logs, or traces are classified to `datasource`; the router then picks the appropriate registered datasource, generates the correct DSL via the per-type prompt, executes the query through `datasource-client.ts`, and feeds the result to Bedrock for analysis.

`src/app/api/ai/route.ts`에 전문 Gateway 라우트(2-8)와 Steampipe `aws-data` 라우트(10) 사이, 우선순위 9의 `datasource` 라우트를 신설했다. 메트릭/로그/추적 질의는 `datasource`로 분류되며 라우터가 적절한 등록 데이터소스를 선택하고 플랫폼별 프롬프트로 DSL을 생성한 뒤 `datasource-client.ts`로 실행하여 Bedrock 분석에 전달한다.

## Rationale / 근거

- **External client layer over Steampipe extension**: Steampipe plugins target configuration state, not high-cardinality telemetry. Writing a Steampipe plugin for PromQL would re-implement a time-series engine inside a PostgreSQL FDW — the wrong shape. A dedicated HTTP client is smaller, faster, and speaks each platform's native protocol.
- Steampipe 확장 대신 외부 클라이언트 계층: Steampipe 플러그인은 구성 상태에 최적화되어 있으며 고-카디널리티 원격 측정과는 맞지 않는다. PromQL용 플러그인을 작성하는 것은 PostgreSQL FDW 안에 시계열 엔진을 재구현하는 격이다.
- **Allowlist + DNS-resolve SSRF defense over egress proxy**: The dashboard accepts URLs from admins who may legitimately target private observability stacks. A blanket egress proxy would block legitimate in-VPC access; DNS resolution plus a blocklist combined with an opt-in feature flag lets operators explicitly declare "this deployment trusts private IPs."
- 송신 프록시 대신 allowlist + DNS 해석 기반 SSRF 방어: 대시보드는 관리자가 입력한 URL을 수용하며 Private VPC 내부의 합법적 관측 스택을 대상으로 할 수 있다. 포괄적 egress proxy는 정상 접근까지 차단하므로, DNS 해석 + 블록리스트 + 옵트인 플래그 조합으로 "이 배포는 사설 IP를 신뢰한다"를 명시적으로 선언하게 한다.
- **Natural-language to DSL generation over a structured builder**: Each platform has an incompatible query language (PromQL rate windows vs LogQL label filters vs TraceQL span attributes vs ClickHouse SQL). A visual query builder would have to be written and maintained per platform. Letting Bedrock translate "show me 5xx rate for the last hour" into the correct DSL per datasource removes that surface while keeping users in a single mental model.
- 구조화 쿼리 빌더 대신 자연어→DSL 생성: 각 플랫폼의 쿼리 언어(PromQL의 rate 윈도, LogQL의 라벨 필터, TraceQL의 span 속성, ClickHouse SQL)가 서로 호환되지 않아 플랫폼별 빌더를 별도 유지해야 한다. Bedrock이 "지난 1시간 5xx 비율"을 데이터소스별 DSL로 번역하면 유지보수 표면을 제거하면서 사용자에게 단일 멘탈 모델을 제공할 수 있다.
- **New AI route over AgentCore Gateway extension**: AgentCore Gateway tools are Lambda functions baked into deployed infrastructure with fixed endpoints. External datasources are configured per-deployment at runtime and can be added or removed without redeploying the AgentCore stack. A native Next.js route reads the current datasource config on every request.
- AgentCore Gateway 확장 대신 신규 AI 라우트: AgentCore Gateway 도구는 고정 엔드포인트를 가진 Lambda로 인프라에 baked-in 되어 있다. 외부 데이터소스는 배포별·런타임에 추가/제거되므로, 요청마다 최신 데이터소스 설정을 읽는 Next.js 네이티브 라우트가 적합하다.

## Security Considerations / 보안 고려 사항

### Token Storage and Masking / 토큰 저장 및 마스킹

Bearer tokens, API keys, and basic-auth credentials are persisted in `data/config.json` (filesystem-permission-protected on the EC2 instance) and are never returned to the browser. `GET /api/datasources` replaces every token field with `***` before serialization. Tokens are never written to application logs — the request logger emits the datasource name only. Rotation is a manual admin operation through the UI.

Bearer 토큰, API 키, basic-auth 자격증명은 `data/config.json`에 저장되며(EC2에서 파일 권한으로 보호) 브라우저로는 절대 반환하지 않는다. `GET /api/datasources`는 직렬화 전 모든 토큰 필드를 `***`로 치환한다. 토큰은 애플리케이션 로그에도 기록되지 않으며(로거는 데이터소스 이름만 출력), 회전은 UI를 통한 수동 관리자 작업이다.

### Admin-Only Mutations / 관리자 전용 변경

Create, update, and delete operations on `/api/datasources` require the requester's Cognito email (extracted via `src/lib/auth-utils.ts`) to appear in `data/config.json` `adminEmails`. Read and query operations are available to any authenticated user, so a compromised non-admin account cannot pivot the dashboard into an SSRF vector by registering a new malicious endpoint.

`/api/datasources`의 생성/수정/삭제는 요청자의 Cognito 이메일(`src/lib/auth-utils.ts`로 추출)이 `data/config.json`의 `adminEmails`에 포함되어야 한다. 조회 및 쿼리 실행은 인증된 모든 사용자가 가능하므로, 비-관리자 계정이 탈취되더라도 악성 엔드포인트를 신규 등록하여 대시보드를 SSRF 피벗으로 사용할 수 없다.

### Manual Redirect Handling / 수동 리다이렉트 처리

`datasource-client.ts` sets `redirect: 'manual'` on every fetch. A successful 3xx response is treated as an error — users see "unexpected redirect" and the request is dropped. This closes the class of SSRF attacks where a public `https://attacker.com` redirects the server-side client to `http://169.254.169.254/latest/meta-data/`.

`datasource-client.ts`는 모든 fetch에 `redirect: 'manual'`을 설정한다. 3xx 응답은 오류로 처리되어 "unexpected redirect" 메시지로 요청을 폐기하며, 이로써 공개 `https://attacker.com`이 서버-사이드 클라이언트를 `http://169.254.169.254/latest/meta-data/`로 우회시키는 SSRF 공격 범주를 차단한다.

## Consequences / 결과

### Positive / 긍정

- Unified AI-driven correlation of AWS configuration and external telemetry within a single conversation.
- Ops teams already running Prometheus/Loki see their existing tooling first-class in the dashboard — no parallel screen-swapping.
- Each platform's native DSL is handled by the AI; users stay in natural language.
- SSRF defense is on by default; private access is an explicit opt-in per account.
- 단일 대화 내에서 AWS 구성과 외부 원격 측정의 통합 AI 상관 분석.
- Prometheus/Loki를 이미 운영 중인 팀은 기존 도구를 대시보드 1급 시민으로 재사용 — 화면 전환 불필요.
- 플랫폼별 DSL은 AI가 처리하므로 사용자는 자연어만 사용.
- SSRF 방어는 기본 활성, 사설 접근은 계정별 명시적 옵트인.

### Negative / 부정

- Attack surface grows: the dashboard now makes outbound HTTP to admin-configured URLs.
- Admins must rotate and revoke tokens manually; there is no built-in secret manager integration yet.
- AI-generated DSL queries can be wrong (hallucinated metric names, incorrect label filters); the UI requires a user confirmation before execution for non-trivial queries.
- 공격 표면 확대: 대시보드가 관리자 설정 URL로 outbound HTTP를 수행.
- 관리자는 토큰을 수동으로 회전·폐기해야 하며, 내장 secret manager 연동은 아직 없음.
- AI 생성 DSL 쿼리는 틀릴 수 있음(존재하지 않는 메트릭 이름, 잘못된 라벨 필터) — UI는 복잡한 쿼리에 대해 실행 전 사용자 확인을 요구.

### Trade-offs / 트레이드오프

- Per-platform client code and per-platform prompts: adding an eighth datasource type is a bounded-but-non-trivial change (registry entry + prompt + any platform-specific client quirks).
- `data/config.json` now carries sensitive token material, raising the bar for backup and filesystem permission hygiene on the EC2 host.
- 플랫폼별 클라이언트 코드와 프롬프트: 8번째 데이터소스 추가는 유한하지만 사소하지 않은 작업(레지스트리 항목 + 프롬프트 + 플랫폼별 quirks).
- `data/config.json`이 이제 민감 토큰을 포함하므로, EC2 호스트의 백업 및 파일시스템 권한 관리 기준이 상향됨.

## References / 참고

- `src/lib/datasource-client.ts` — HTTP client, SSRF allowlist, manual redirect handling
- `src/lib/datasource-registry.ts` — Per-type metadata registry
- `src/lib/datasource-prompts.ts` — Natural-language to DSL prompts
- `src/app/api/datasources/route.ts` — CRUD, query execution, AI query generation
- `src/app/datasources/page.tsx`, `src/app/datasources/explore/page.tsx` — Datasource management and explorer UI
- `src/app/api/ai/route.ts` — 11-route AI router with priority-9 `datasource` route
- `src/lib/auth-utils.ts` — Cognito JWT admin check
- `/home/ec2-user/awsops/CLAUDE.md` — Project conventions and architecture overview
- Landed in commits `d3f5c19` (datasource, diagnosis, auto-collect agents, SNS notification) and `b23be07` (FinOps MCP Lambda, deployment scripts, CDK updates) — AWSops v1.8.0
