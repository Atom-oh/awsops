# ADR-042: v2 In-App Login (Cognito USER_PASSWORD_AUTH) / v2 인앱 로그인 (Cognito USER_PASSWORD_AUTH)

<!-- Renumbered 039 → 042 on 2026-06-15 to resolve a merge collision: origin's ADR-039 (multi-agent platform) holds 039. Co-agent panel (kiro + Gemini 3.1 Pro) unanimously chose Option A — keep origin's cross-referenced 039/040/041 block, renumber leaf ADRs (this login → 042, neptune-graph → 043). -->

## Status / 상태

Accepted (2026-06-12) / 채택 (2026-06-12) — 사용자 승인(인증 = v1식 자체 폼, 외형 = AgentCore teal 테마) + 컨센서스 게이트 통과. 설계 스펙: `docs/superpowers/specs/2026-06-12-login-screen-design.md`. 구현 플랜: `docs/superpowers/plans/2026-06-12-login-screen.md`.

This ADR records the v2 sign-in **user experience** decision: a self-hosted `/login` form backed by a thin-BFF `InitiateAuth` call, replacing the Cognito Hosted UI as the **primary** authentication path. It **relates to ADR-037** (the v2 foundation it builds on) and **refines the auth surface of ADR-020** (Cognito + Lambda@Edge), whose edge validator and cookie contract are reused unchanged.

본 ADR은 v2 로그인 **사용자 경험** 결정을 기록한다: thin-BFF `InitiateAuth` 호출로 뒷받침되는 자체 호스팅 `/login` 폼이 Cognito Hosted UI를 **주 경로**에서 대체한다. **ADR-037**(기반 v2 파운데이션)과 **연관**되며, **ADR-020**(Cognito + Lambda@Edge)의 인증 표면을 정제한다 — 엣지 검증기와 쿠키 계약은 변경 없이 재사용한다.

## Context / 컨텍스트

v2 (ADR-037 foundation) terminates auth at the CloudFront edge via Lambda@Edge (RS256 JWKS + iss/aud/token_use, OAuth `state`, PKCE public client per ADR-020's v2 hardening). Unauthenticated requests are redirected to the **Cognito Hosted UI**, and the authorization-code (PKCE) round-trip is completed at the edge `/_callback` handler, which sets the `awsops_token` ID-token cookie.

v2(ADR-037 파운데이션)는 Lambda@Edge(RS256 JWKS + iss/aud/token_use, OAuth `state`, PKCE public client — ADR-020의 v2 강화)로 CloudFront 엣지에서 인증을 종료한다. 미인증 요청은 **Cognito Hosted UI**로 리다이렉트되고, authorization-code(PKCE) 왕복이 엣지 `/_callback` 핸들러에서 완료되어 `awsops_token` ID-토큰 쿠키를 설정한다.

Three facts shape the decision / 결정을 규정하는 세 가지 사실:

- **v1 shipped an in-app login form** (`/awsops/login` → `POST /api/auth` → Cognito `InitiateAuth`), and ADR-020's own Option-1 description already presumes an in-app login page rather than the Hosted UI as the day-to-day surface. The Hosted UI redirect was a v2 stopgap, not a product decision. / **v1은 인앱 로그인 폼을 출하**했고(`/awsops/login` → `POST /api/auth` → Cognito `InitiateAuth`), ADR-020의 Option-1 서술 자체가 Hosted UI가 아닌 인앱 로그인 페이지를 상시 표면으로 전제했다. Hosted UI 리다이렉트는 v2 임시방편이었지 제품 결정이 아니었다.
- The Hosted UI cannot be themed to match the AgentCore teal design system; it breaks the visual continuity of the dashboard and exposes Cognito-branded chrome. / Hosted UI는 AgentCore teal 디자인 시스템에 맞게 테마링할 수 없어 대시보드의 시각적 연속성을 깨고 Cognito 브랜드 크롬을 노출한다.
- The cookie format that matters downstream is **the `awsops_token` ID-token cookie** the edge validator already verifies (RS256 + claims). Cognito `InitiateAuth` (`USER_PASSWORD_AUTH`) returns a normally-issued `IdToken` of the same shape, so a self-hosted form can mint the identical cookie **without any change to the edge validator** — the validation boundary is preserved. / 하위에서 중요한 쿠키 형식은 엣지 검증기가 이미 검증하는(RS256 + 클레임) **`awsops_token` ID-토큰 쿠키**다. Cognito `InitiateAuth`(`USER_PASSWORD_AUTH`)는 동일한 형태의 정상 발급 `IdToken`을 반환하므로, 자체 폼이 **엣지 검증기 변경 없이** 동일 쿠키를 발급할 수 있다 — 검증 경계가 보존된다.

## Options Considered / 고려한 대안

### Option A: Self-hosted `/login` form + unsigned public `InitiateAuth` — **chosen / 채택**
- **Pros / 장점**: themed (AgentCore teal token-based) sign-in matching the dashboard; identical UX to v1; the BFF call is the **unsigned public `InitiateAuth` operation** (no SDK dependency, no task-role credentials — plain fetch to `cognito-idp.{region}.amazonaws.com`); edge validator and `awsops_token` cookie contract untouched; thin-BFF stays stateless (no brute-force state — delegated to Cognito's built-in throttle/lockout). / 대시보드와 일치하는 테마(AgentCore teal 토큰 기반) 로그인; v1과 동일한 UX; BFF 호출은 **무서명 공개 `InitiateAuth` 오퍼레이션**(SDK 의존성·task-role 자격증명 불필요 — `cognito-idp.{region}.amazonaws.com`로의 plain fetch); 엣지 검증기·`awsops_token` 쿠키 계약 불변; thin-BFF는 무상태 유지(브루트포스 상태 없음 — Cognito 내장 스로틀/lockout에 위임).
- **Cons / 단점**: the app now handles raw passwords (over HTTPS, never logged, never persisted); the primary path loses Hosted-UI MFA / password-reset / federation; `NEW_PASSWORD_REQUIRED` and other challenges are surfaced as a single "contact your administrator" message rather than handled inline. / 앱이 이제 원시 비밀번호를 처리한다(HTTPS 경유, 미로깅, 미영속); 주 경로가 Hosted-UI MFA/비밀번호 재설정/페더레이션을 잃는다; `NEW_PASSWORD_REQUIRED` 등 챌린지는 인라인 처리가 아닌 단일 "관리자에게 문의" 메시지로 노출된다.

### Option B: Branded landing page → redirect to Hosted UI — rejected / 브랜드 랜딩 → Hosted UI 리다이렉트 — 기각
- **Pros / 장점**: keeps Hosted UI's MFA / reset / federation; no password handling in the app. / Hosted UI의 MFA/재설정/페더레이션 유지; 앱 내 비밀번호 처리 없음.
- **Cons / 단점**: the credential entry screen is still un-themable Cognito chrome — only the landing page is branded, so the visual break persists at the exact moment of credential entry; double redirect; does not match the approved v1-style requirement. / 자격증명 입력 화면은 여전히 테마 불가한 Cognito 크롬 — 랜딩만 브랜드되어 자격증명 입력 바로 그 순간 시각적 단절이 남는다; 이중 리다이렉트; 승인된 v1식 요건과 불일치.

### Option C: SRP (Secure Remote Password) flow — deferred / SRP(Secure Remote Password) 플로우 — 연기
- **Pros / 장점**: the password never leaves the client in plaintext (zero-knowledge proof); stronger posture if the BFF were ever compromised. / 비밀번호가 클라이언트를 평문으로 떠나지 않음(영지식 증명); BFF 침해 시에도 더 강한 자세.
- **Cons / 단점**: `USER_SRP_AUTH` requires SRP-protocol crypto (a client SDK or hand-rolled big-integer math) — a large dependency/complexity jump for a thin-BFF, while TLS already protects the password in transit and the BFF never logs/persists it. Revisit if a no-plaintext-at-BFF requirement emerges. / `USER_SRP_AUTH`는 SRP 프로토콜 암호(클라이언트 SDK 또는 수제 big-integer 연산)를 요구 — thin-BFF에는 큰 의존성/복잡도 도약인 반면 TLS가 이미 전송 중 비밀번호를 보호하고 BFF는 로깅/영속하지 않는다. BFF 평문 금지 요건이 생기면 재검토.

## Decision / 결정

Adopt **Option A**. Implemented per the spec / 스펙대로 구현. 핵심:

1. **Self-hosted `/login` page** (`web/app/login/page.tsx`) — AgentCore teal theme, **token-based only** (follows the active theme: teal light by default, dark under the console theme). Email/password form, "keep me signed in" checkbox, a single inline `negative`-tone error box. No SSO grid (only IdP is `COGNITO`), no password-reset link (Hosted-UI-dependent). `ShellGate` mounts the app shell (sidebar / Cmd-K / chat drawer) on every route **except** `/login`. / **자체 `/login` 페이지** — AgentCore teal 테마, **토큰 기반 only**(활성 테마 추종: 기본 teal 라이트, console 테마 시 다크). `ShellGate`가 `/login`을 **제외한** 모든 경로에 앱 셸을 탑재.
2. **BFF `POST /api/auth/login`** (`web/app/api/auth/login/route.ts`) calls Cognito **`InitiateAuth(USER_PASSWORD_AUTH)`** as an **unsigned public operation** via plain fetch (`X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`, `Content-Type: application/x-amz-json-1.1`) — no SDK, no IAM. On success it sets `awsops_token=<IdToken>; Path=/; Secure; HttpOnly; SameSite=Lax`; `remember` ✓ → `Max-Age=43200` (12h, the id_token lifetime), ✗ → session cookie. `NotAuthorizedException`/`UserNotFoundException` collapse to a single `invalid_credentials` message (account existence not disclosed); any `ChallengeName` → `challenge` (403, "contact your administrator"); network/5xx → `unavailable` (502). / **BFF `POST /api/auth/login`**이 무서명 공개 오퍼레이션으로 `InitiateAuth(USER_PASSWORD_AUTH)`를 plain fetch 호출. 성공 시 쿠키 발급(remember → `Max-Age=43200`, 미선택 → 세션 쿠키). 오류는 단일 코드(`invalid_credentials`/`challenge`/`unavailable`)로 수렴 — 계정 존재 비노출.
3. **Edge Lambda redirects unauthenticated traffic to `/login`** (`edge-lambda/cognito_edge.py.tftpl` `login_redirect()` → `302 Location: /login?next={quoted uri}`, `Cache-Control: no-cache`). `is_public()` additively allows `/login`, `/api/auth/login`, `/icon.svg` (login page, auth API, favicon must be reachable unauthenticated). The Hosted UI PKCE path (`start_login` / `handle_callback`, flow-cookie `Max-Age=600`) is **retained as a dark fallback** — only the redirect target changed. `next` is validated client-side against open-redirect (must start `/`, 2nd char not `/` or `\`, no `\`, ≤2048 chars; defaults to `/`). / **엣지 Lambda가 미인증 트래픽을 `/login`으로 리다이렉트**. `is_public()`에 `/login`·`/api/auth/login`·`/icon.svg` additive 추가. Hosted UI PKCE 경로는 **다크 폴백으로 보존** — redirect 대상만 변경. `next`는 클라이언트에서 오픈 리다이렉트 차단 검증.
4. **Cognito client (`auth.tf`)**: `explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH"]` — **least-privilege: no `ALLOW_REFRESH_TOKEN_AUTH`** (the BFF implements no refresh flow and discards any returned RefreshToken). `id_token_validity = 12` + `access_token_validity = 12` + `token_validity_units { id_token = "hours", access_token = "hours" }`. **id_token lifetime = 12h** (was 1h); the edge fallback `handle_callback` token cookie `Max-Age` is aligned 3600 → 43200. / **Cognito 클라이언트**: `ALLOW_USER_PASSWORD_AUTH`만(최소권한 — `ALLOW_REFRESH_TOKEN_AUTH` 미부여, BFF는 RefreshToken 즉시 폐기). **id_token 수명 = 12h**(기존 1h); 엣지 폴백 쿠키 Max-Age도 43200으로 정합.
5. **Signout simplified** (`web/app/api/auth/signout/route.ts` + `UserIdentity.tsx`): the self-hosted form has no Cognito browser session, so signout drops the Hosted UI `/logout` round-trip — it clears the cookie (`Max-Age=0`) and returns `{ redirect: '/login' }`. / **signout 단순화**: 자체 폼엔 Cognito 브라우저 세션이 없으므로 Hosted UI `/logout` 왕복 제거 — 쿠키 삭제(`Max-Age=0`) 후 `/login`으로 직행.

## Consequences / 영향

### Positive / 긍정적
- Themed, on-brand sign-in (AgentCore teal) with v1-equivalent UX and no Cognito-chrome visual break. / 브랜드 일관(AgentCore teal) 로그인, v1 동등 UX, Cognito 크롬 단절 없음.
- The edge RS256 validator and `awsops_token` cookie contract are unchanged — the self-hosted form mints a cookie the existing validator accepts, so the trust boundary (validate-at-edge) is preserved end-to-end. / 엣지 RS256 검증기·`awsops_token` 쿠키 계약 불변 — 신뢰 경계(엣지 검증)가 종단 보존.
- Thin-BFF stays stateless and credential-free: `InitiateAuth` is unsigned/public, so no task-role grant or SDK dependency is added; brute-force defense is delegated to Cognito. / thin-BFF 무상태·무자격증명 유지: `InitiateAuth`는 무서명/공개라 task-role 부여·SDK 의존성 추가 없음; 브루트포스 방어는 Cognito 위임.
- Least-privilege: omitting `ALLOW_REFRESH_TOKEN_AUTH` keeps long-lived refresh tokens out of the browser/BFF entirely; the 12h id_token is the whole session. / 최소권한: `ALLOW_REFRESH_TOKEN_AUTH` 생략으로 장수명 refresh 토큰이 브라우저/BFF에서 완전히 배제; 12h id_token이 세션 전부.

### Negative / 부정적
- The app handles raw passwords (over HTTPS; never logged, never persisted) — a new (if small) credential-handling surface that the Hosted-UI path did not have. / 앱이 원시 비밀번호를 처리(HTTPS 경유·미로깅·미영속) — Hosted UI 경로엔 없던(작지만) 자격증명 처리 표면.
- The primary path loses Hosted-UI MFA / password-reset / federation; challenges (`NEW_PASSWORD_REQUIRED`, etc.) surface as a single "contact your administrator" message instead of an inline flow. These remain available via the retained PKCE dark fallback if re-enabled. / 주 경로가 Hosted-UI MFA/비밀번호 재설정/페더레이션을 잃음; 챌린지는 인라인 플로우 대신 단일 "관리자 문의" 메시지로 노출. 보존된 PKCE 다크 폴백 재활성화 시 복구 가능.
- 12h id_token (vs 1h) widens the window in which a leaked cookie is valid; mitigated by HttpOnly + Secure + SameSite=Lax and the absence of any refresh token. / 12h id_token(기존 1h)은 유출 쿠키 유효 창을 넓힘; HttpOnly+Secure+SameSite=Lax 및 refresh 토큰 부재로 완화.
- `next` must be sanitized against open redirect on every login (start `/`, 2nd char ≠ `/`·`\`, no `\`, ≤2048; the `\`→`/` browser normalization bypass is covered) or the form becomes an open-redirect vector. / 매 로그인마다 `next`를 오픈 리다이렉트에 대해 정제해야 함(`/` 시작, 2번째 문자 ≠ `/`·`\`, `\` 미포함, ≤2048; 브라우저 `\`→`/` 정규화 우회까지 차단) — 아니면 폼이 오픈 리다이렉트 벡터가 됨.

### Post-acceptance deviations / 채택 후 편차
- (none yet) / (아직 없음)

## References / 참고 자료
- Design spec: `docs/superpowers/specs/2026-06-12-login-screen-design.md`; implementation plan: `docs/superpowers/plans/2026-06-12-login-screen.md`.
- ADR-037 (v2 foundation — thin-BFF + edge this builds on), ADR-020 (Cognito + Lambda@Edge — RS256 edge validator + `awsops_token` cookie reused; in-app login presumed in its Option 1), ADR-026 (i18n LanguageProvider — login copy), ADR-023 (admin model — Cognito group + SSM allowlist keyed off the same id_token).
- Code: `web/app/login/page.tsx`, `web/app/api/auth/login/route.ts`, `web/lib/login.ts`, `web/app/api/auth/signout/route.ts`, `web/components/shell/{ShellGate,UserIdentity}.tsx`, `terraform/v2/foundation/auth.tf`, `terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl`.
