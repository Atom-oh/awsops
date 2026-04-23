# ADR-023: Admin Role Model via `adminEmails` Config / `adminEmails` 설정 기반 관리자 역할 모델

## Status / 상태

Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops exposes several administrative surfaces — `/accounts` (add/remove AWS accounts), `/alert-settings` (rotate webhook HMAC secrets, Slack channel mapping), `/datasources` (mutate external datasource connections), and the AI diagnosis scheduler — that must not be reachable by every authenticated Cognito user. The product is deployed as a single-tenant EC2 instance per customer, typically shared by an operations team of 1-10 people. We needed a way to gate these surfaces without introducing new identity infrastructure and without forcing operators to learn a second access-control system on top of Cognito (ADR-020).

AWSops는 `/accounts` (AWS 계정 추가·삭제), `/alert-settings` (웹훅 HMAC 시크릿 회전, Slack 채널 매핑), `/datasources` (외부 데이터소스 변경), AI 진단 스케줄러 등 모든 인증 사용자에게 열려 있으면 안 되는 관리 화면을 노출한다. 제품은 고객별 EC2 단일 인스턴스 형태로 배포되며 보통 1~10명 규모의 운영팀이 공유한다. 새로운 아이덴티티 인프라를 추가하지 않고, 운영자가 Cognito (ADR-020) 위에 또 다른 권한 체계를 학습하지 않도록 관리 화면을 게이팅하는 방법이 필요했다.

## Options Considered / 검토한 대안

### Option 1 — `adminEmails` array in `data/config.json` (chosen) / `data/config.json`의 `adminEmails` 배열 (채택)

A single `adminEmails?: string[]` field on `AppConfig` holds the list of privileged users. Both UI (via `GET /api/steampipe?action=admin-check`) and server mutations (`POST /api/steampipe` add-account, `api/datasources` CRUD, `api/report` schedule writes) resolve `user.email` from the Cognito JWT and compare against this list.

`AppConfig`의 `adminEmails?: string[]` 필드 하나로 특권 사용자 목록을 관리한다. UI (`GET /api/steampipe?action=admin-check`)와 서버 변경 엔드포인트 (`POST /api/steampipe` add-account, `api/datasources` CRUD, `api/report` 스케줄 쓰기) 모두 Cognito JWT의 `user.email`을 추출해 이 목록과 비교한다.

### Option 2 — Cognito Groups with JWT group claim / Cognito 그룹 + JWT 그룹 클레임

Create an `Admins` Cognito group, attach users via IAM/console, and parse `cognito:groups` from the JWT. This is already used for the `DepartmentConfig.cognitoGroup` feature, so the machinery exists.

Cognito에 `Admins` 그룹을 만들고 사용자를 IAM/콘솔로 추가한 뒤 JWT의 `cognito:groups` 클레임을 파싱한다. `DepartmentConfig.cognitoGroup` 기능에서 이미 사용 중이라 기반은 갖춰져 있다.

### Option 3 — IAM-based (Cognito Identity Pool → IAM roles) / IAM 기반 (Cognito Identity Pool → IAM 역할)

Federate authenticated users into AWS IAM roles and check role ARN on each admin call.

인증된 사용자를 AWS IAM 역할로 페더레이션하고 관리 호출마다 역할 ARN을 검증한다.

### Option 4 — Environment variable (`AWSOPS_ADMIN_EMAILS=a@x,b@y`) / 환경 변수

Read a comma-separated list from the process environment at boot.

부팅 시 프로세스 환경에서 쉼표로 구분된 목록을 읽는다.

## Decision / 결정

Adopt Option 1. The authoritative source is `AppConfig.adminEmails?: string[]` in `data/config.json` (see `src/lib/app-config.ts:117`). Admin enforcement is performed server-side in every mutating route by resolving the caller's email from the verified Cognito JWT (`getUserFromRequest` in `src/lib/auth-utils.ts`) and checking membership in the list. The client may additionally hide admin affordances, but hiding is cosmetic only — the server is the enforcement boundary.

Option 1을 채택한다. 권위 있는 출처는 `data/config.json`의 `AppConfig.adminEmails?: string[]` (`src/lib/app-config.ts:117`)이다. 관리자 확인은 모든 변경 라우트에서 서버사이드로 수행하며, 검증된 Cognito JWT에서 호출자 이메일을 추출 (`src/lib/auth-utils.ts`의 `getUserFromRequest`)한 뒤 목록 포함 여부를 확인한다. 클라이언트는 UI를 숨길 수 있지만 이는 표시적 장치일 뿐 실제 차단은 서버에서 이루어진다.

```typescript
// src/app/api/steampipe/route.ts — admin-check endpoint
const adminEmails = config.adminEmails || [];
const isAdmin =
  user.email !== 'anonymous' &&
  (adminEmails.length === 0 || adminEmails.includes(user.email));
```

Semantics of an empty or missing list differ by surface and are deliberate:
- `/accounts`, `/alert-settings`, scheduler writes → fail-closed with `403` when `adminEmails.length > 0` and the caller is not listed; when the list is empty, all authenticated (non-anonymous) users are treated as admin so a fresh install is usable before the operator configures the list.
- `/datasources` mutations use the same "empty means everyone is admin" rule, documented inline in `src/app/api/datasources/route.ts:109`.

빈 목록/미설정 시 동작은 화면별로 의도적으로 다르다.
- `/accounts`, `/alert-settings`, 스케줄러 쓰기 → `adminEmails.length > 0`이고 호출자가 목록에 없으면 `403`으로 fail-closed. 목록이 비어 있으면 인증된(익명이 아닌) 모든 사용자를 관리자 취급하여 최초 설치 직후에도 사용 가능.
- `/datasources` 변경도 동일한 "빈 목록 = 전원 관리자" 규칙을 따르며 `src/app/api/datasources/route.ts:109`에 주석화되어 있다.

## Rationale / 근거

- **Config file over Cognito Groups (Option 2):** AWSops is single-tenant per EC2 instance with a small operator pool. Cognito Groups would require an extra IAM permission grant to the operator, CDK wiring (`cognito-stack.ts`), JWT group-claim parsing at every endpoint, and a second place (the Cognito console) to audit who is admin. The marginal benefit does not justify the split surface area. / Cognito Groups는 IAM 권한, CDK 배선, 감사 화면 분리 부담을 추가하지만 단일 테넌트·소규모 운영팀에는 이득이 작다.
- **Email over Cognito `sub` (Option 2/3):** Email is stable, human-readable in ticket handoffs, and already extracted by `auth-utils.ts`. Cognito `sub` is an opaque UUID — unaudiable in a plain config file. / 이메일은 안정적이고 사람이 읽을 수 있어 티켓 인수인계·설정 감사에 유리하다. `sub`는 UUID라 가독성이 없다.
- **Not IAM-based (Option 3):** Dashboard users are Cognito principals, not AWS principals. IAM roles in this system belong to the EC2 host itself (for Steampipe AssumeRole into target accounts and AgentCore invocation). Mapping dashboard identity into IAM would mean running an Identity Pool purely for an allowlist check — far more infrastructure than the problem warrants. / 대시보드 사용자는 AWS 프린시펄이 아닌 Cognito 사용자다. IAM 역할은 EC2 호스트 자체(Steampipe AssumeRole, AgentCore 호출)에 속한다.
- **Config file over env var (Option 4):** `data/config.json` already carries arrays (`accounts[]`, `notificationEmails[]`, `datasources[]`), is hot-reloaded by `getConfig()` with a 60s TTL cache, and can be reviewed in a single place by the operator. Env vars force a restart and stringified list parsing. / 환경 변수는 재시작이 필요하고 문자열 파싱 부담이 있으나 config는 이미 배열을 지원하고 60초 TTL로 핫리로드된다.
- **Server-side check, not UI hiding:** UI hiding prevents confusion but is not security. Every admin API route re-checks `adminEmails` against the verified JWT email before mutating state. / UI 숨김은 보안이 아니므로 모든 관리 API가 JWT 이메일을 재검증한다.
- **Fail-closed on populated list:** Once `adminEmails` has at least one entry, unlisted users get `403`. This avoids the "no list = everyone is admin" footgun for configured deployments. / 목록에 한 명이라도 있으면 그 외 사용자는 `403`으로 차단되어 "목록 없음 = 전원 관리자" 함정을 피한다.

## Consequences / 결과

### Positive / 긍정적

- One-line operator action to grant admin: append an email to `data/config.json`. No AWS console, no IAM, no Cognito group assignment. / 관리자 부여는 설정 파일 한 줄 추가로 끝난다.
- The admin list is trivially auditable — it lives next to the account list and is version-controllable. / 관리자 목록이 계정 목록 옆에 있어 감사·버전 관리가 쉽다.
- Zero new infrastructure cost: no Identity Pool, no Cognito group, no CDK changes. / 신규 인프라 비용이 없다.
- Fresh-install safe: empty list lets the first operator log in and configure the list without a chicken-and-egg lockout. / 최초 설치 시 잠금 상태가 발생하지 않는다.
- Admin API endpoints are paired with per-user rate limits (5/min for account management, documented in `src/app/accounts/CLAUDE.md`) and are audit-loggable by email, not UUID. / 관리 API는 사용자당 rate limit과 이메일 기반 감사로그로 보강된다.

### Negative / 부정적

- No RBAC granularity — admin is all-or-nothing. A user who should only manage datasources cannot be scoped to that surface; they get full admin or none. / RBAC 세분화가 없어 부분 권한이 불가능하다.
- Admin membership changes require editing `data/config.json` on the EC2 host (or redeploy); there is no self-service invite/approval flow. / 관리자 변경은 EC2의 설정 파일 편집이 필요하며 셀프서비스 흐름이 없다.
- Cognito-side user removal does not immediately revoke admin — the operator must also remove the email from `adminEmails`. A disabled Cognito user cannot log in, but the defensive pairing is still the operator's responsibility. / Cognito에서 사용자를 비활성화해도 `adminEmails`를 함께 비우지 않으면 목록에 흔적이 남는다.
- Email as identifier assumes the Cognito email claim is trustworthy. Lambda@Edge verifies the JWT signature (ADR-020), and emails in Cognito User Pools are verified at signup, so this holds for our deployment model but would not be safe in a multi-IdP federation. / 이메일 신뢰는 Cognito의 이메일 검증에 의존하므로 다중 IdP 페더레이션에는 부적합하다.
- If `adminEmails` is accidentally emptied in production, all authenticated users regain admin. Operators should treat the field as a safety-critical setting. / 프로덕션에서 목록을 실수로 비우면 모든 인증 사용자가 관리자로 승격된다.

## References / 참조

- `src/lib/app-config.ts` — `AppConfig.adminEmails` declaration at line 117 / `AppConfig.adminEmails` 선언 (117행)
- `src/lib/auth-utils.ts` — `getUserFromRequest` email extraction from Cognito JWT / Cognito JWT에서 이메일 추출
- `src/app/api/steampipe/route.ts` — `admin-check` endpoint (lines 60-66) and add-account gate (lines 150-155) / `admin-check` 엔드포인트 및 계정 추가 게이트
- `src/app/api/datasources/route.ts` — `isAdminUser`/`checkAdmin` helpers (lines 109-122) / `isAdminUser`/`checkAdmin` 헬퍼
- `src/app/accounts/page.tsx` — client-side access-denied rendering when `isAdmin` is false / `isAdmin`이 false일 때 접근 거부 화면
- `src/app/accounts/CLAUDE.md` — operator-facing notes on admin gate / 관리자 게이트 운영 메모
- ADR-020 — Cognito authentication provides the verified identity consumed here / ADR-020 — 본 문서가 소비하는 검증된 아이덴티티를 제공
