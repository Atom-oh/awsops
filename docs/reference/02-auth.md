# 02. Auth & Identity — v2 Reference

## Purpose / 목적

v2 puts a **Cognito-backed edge auth check in front of the CloudFront edge** so unauthenticated requests never reach the ECS Fargate web tier (or consume ALB capacity). Authentication terminates at the edge and a verified Cognito ID token cookie (`awsops_token`) flows downstream. v2 hardens the v1 model from an expiry-only check to **cryptographic RS256 signature verification** at the edge — only then is the downstream "decode-only, trust the edge" model genuinely sound. **Login itself is the self-hosted `/login` form (ADR-042)** — the BFF calls the unsigned public Cognito `InitiateAuth(USER_PASSWORD_AUTH)` and mints `awsops_token`; the original Hosted-UI OAuth code/PKCE flow (`/_callback`) is retained only as a dark fallback, not the primary path.

v2는 **Cognito 기반 인증 체크를 CloudFront 엣지 앞단에 배치**하여 인증되지 않은 요청이 ECS Fargate 웹 티어에 도달하지 않게 한다(ALB 용량도 소비하지 않음). 인증은 엣지에서 종료되고, 검증된 Cognito ID 토큰 쿠키(`awsops_token`)가 하위로 전파된다. v2는 v1의 만료(exp) 전용 검사를 **RS256 서명 검증**으로 강화했다 — 이로써 하위 앱의 "디코드만 하고 엣지를 신뢰" 모델이 비로소 타당해진다. **로그인 자체는 자체 호스팅 `/login` 폼(ADR-042)** — BFF가 무서명 공개 Cognito `InitiateAuth(USER_PASSWORD_AUTH)`를 호출해 `awsops_token`을 발급한다; 기존 Hosted-UI OAuth code/PKCE 플로우(`/_callback`)는 주 경로가 아니라 다크 폴백으로만 남아있다.

## Current design / 현행 설계

- **Cognito User Pool** `ap-northeast-2_EXAMPLE01` — `username_attributes = ["email"]`, MFA off, password policy min-8 / upper / lower / number, **symbols NOT required** (Cognito onboarding quirk).
- **App client** `EXAMPLECLIENTID0123456789` — **public client, no secret** (`generate_secret = false`); OAuth `code` flow with PKCE, scopes `openid email profile`. Callback `https://<domain>/_callback`, logout `https://<domain>/`.
- **Hosted-UI domain** `a-ops-v2-auth-123456789012` → `https://a-ops-v2-auth-123456789012.auth.ap-northeast-2.amazoncognito.com`.
- **Lambda@Edge** `awsops-v2-cognito-auth` — `python3.12`, **`us-east-1`** (the only region Lambda@Edge permits), 128 MB / 5 s, attached to the CloudFront distribution at the **`viewer-request`** event (fires before cache lookup).
  - Verifies the ID token via **pure-python RS256** (RSASSA-PKCS1-v1_5 + SHA-256) against Cognito's **JWKS** (`/.well-known/jwks.json`, cached in a module global) — no extra deps, stays under the 1 MB viewer-request limit.
  - Validates claims: `iss`, `aud` (= client id), `token_use == 'id'`, `exp`/`iat`/`nbf`.
  - Enforces OAuth **`state`** + **PKCE** (S256 challenge; verifier stored in a short-lived HMAC-signed `awsops_flow` cookie) — CSRF defense, and no client secret is compiled into the edge code (HMAC `state_key` injected via `random_password` at apply).
  - **Public-path bypass** (`is_public()`, 7 routes): `/_next/static/*` (immutable assets), `/api/health` (smoke target), `/icon.svg` (favicon), `/login` (self-hosted login page), `/api/auth/login` (unsigned `InitiateAuth` BFF endpoint), `/api/auth/signout` (cookie clear), `/api/incidents/webhook` (own HMAC/SNS verification, flag-gated). Unauthenticated requests to any other path are redirected to `/login`, not the Cognito Hosted UI.
- **Served at root path `/`** — v2 dropped the v1 `/awsops` basePath; primary login is `/login`, Hosted-UI callback (`/_callback`) is the dark fallback, post-login redirect is `/`.
- **Admin user** `admin@awsops.local`, created from gitignored `terraform.tfvars` (`admin_email` / `admin_password`).
- Cookie flags: `awsops_token=<id_token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200` (12h — matches Cognito `id_token_validity`/`access_token_validity`, both set to 12 hours in `auth.tf`).

## Decisions (ADRs) / 결정

- [ADR-002 — Auth & Login (Cognito + Lambda@Edge)](../../decisions/002-auth-and-login.md) — Accepted (2026-04-22). Edge-level rejection over ALB-native / Next.js-middleware / SigV4 alternatives; `viewer-request` over `origin-request`; HttpOnly cookie; decode-only at the app trusting the edge.
  - **2026-06-03 "Post-acceptance deviation":** the v1 edge was **exp-only** (base64 decode + expiry, no signature verification), so the "decode-only app trusts the edge" claim was not actually backed by signature verification. v2 (`feat/v2-architecture-design`, commit `8313b0e`) hardens the edge to **JWKS RS256 signature verification** + issuer/audience checks + OAuth `state` + PKCE public client (secret dropped). Operators on v1 should treat edge auth as exp-only until v2 is deployed.
- **ADR-042 — self-hosted `/login` supersedes Hosted-UI as the primary flow.** Login = `/login` page (`web/app/login/`) → `POST /api/auth/login` (`web/app/api/auth/login/route.ts`) → unsigned public `InitiateAuth(USER_PASSWORD_AUTH)` (`web/lib/login.ts`) → mints `awsops_token` (12h). Edge `is_public()` allowlists `/login` + `/api/auth/login`; unauthenticated requests redirect to `/login`, not Cognito. The Hosted-UI PKCE flow (`/_callback`, described above) is retained as a **dark fallback** only.

## Key files / 핵심 파일

- `terraform/v2/foundation/auth.tf` — Cognito user pool + public client (PKCE) + Hosted-UI domain + admin user + Lambda@Edge function/role + `random_password.edge_state_key` + `templatefile` injection. Also sets `explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH"]` and 12h `id_token_validity`/`access_token_validity` for the in-app login path.
- `terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl` — Python Lambda@Edge source (templated): JWKS RS256 verify, claim checks, `state`/PKCE flow (dark fallback), `is_public()` bypass list, `login_redirect()` → self-hosted `/login`.
- `web/app/login/`, `web/app/api/auth/login/route.ts`, `web/lib/login.ts` — the primary in-app login path (ADR-042): unsigned `InitiateAuth(USER_PASSWORD_AUTH)` → `awsops_token` cookie.

## Status / 상태

- **P1b + P1d ✅** — browser login e2e verified. **ADR-042 ✅** — in-app `/login` supersedes Hosted-UI as the primary flow.
  - P1b shipped Cognito + the edge function (initially exp-only, ported from v1 for parity) and an unauthenticated `302 → Cognito /login` redirect through CloudFront.
  - P1d hardened the edge to RS256 + `state` + PKCE (public client replacing the secret client) and cut the web tier over to the real Next.js image.
  - ADR-042 replaced the unauthenticated redirect target with the self-hosted `/login` page + `InitiateAuth` BFF; Hosted-UI PKCE is now the dark fallback.
- e2e checks: self-hosted `/login` → BFF `InitiateAuth` → web succeeds; root without cookie → `302` to `/login`; a **forged token → `302`** (rejected), confirming signature verification works (a pre-hardening build would have returned `200`).

## Learnings & gotchas / 학습·함정

- **`aws` is a Cognito reserved word** — a domain prefix containing `aws` is rejected, so the Hosted-UI domain dropped the prefix → `a-ops-v2-auth-123456789012`.
- **Exp-only edge auth is insecure** — a base64 decode + `exp` check does NOT verify the signature. A decode-only app trusting an exp-only edge would accept a **forged/altered JWT**. v2 fixes this with **JWKS RS256 verification** (pure-python, no dependencies, safely under the 1 MB Lambda@Edge viewer-request size limit).
- **The Cognito app client was REPLACED, not edited, when moving to PKCE** — the old secret client was destroyed and a new public client (`generate_secret = false`) created (hence the new client id). Admin credentials were unchanged.
- **No client secret in edge code** — the public client authenticates the token exchange with the PKCE `code_verifier`; the HMAC `state_key` (for the signed `awsops_flow` cookie) is the only secret rendered into the function, injected at apply via `random_password`.
- **Lambda@Edge has no env vars** — config (client id, domain, region, user pool id, state key) is injected at apply time through `templatefile` into the `.tftpl` source.
- **Lambda@Edge is region-locked to `us-east-1`** and must be published (versioned ARN) to attach to CloudFront; auth-failure debugging reads CloudWatch Logs in the executing edge region, not the app logs (the app never sees rejected requests).
- **JWKS fetch adds a cold-start outbound call** — cached in a module global, within the 5 s timeout.

## Source / 출처

- Plans (to be archived under `docs/superpowers/archive/`): `2026-05-31-awsops-v2-p1b-cognito-edge-auth.md` (primary), `2026-05-31-awsops-v2-p1d-web-cicd-auth.md` (RS256 / PKCE auth-hardening, Task D4).
- Decision: `docs/decisions/020-cognito-lambda-edge-auth.md` (esp. the 2026-06-03 post-acceptance RS256 note).
- Review: `docs/reviews/v2-p1d-readiness-architecture-review.md` (3-AI cross review — CRITICAL JWKS / HIGH state+PKCE drivers).
- Code: `terraform/v2/foundation/auth.tf`, `terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl`.
