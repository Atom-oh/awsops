# ADR-002: Authentication, Login, and Ownership

## Status

Accepted **2026-06-22**. Consolidates legacy ADRs 020, 023, and 042.
Public-path/PWA description amended **2026-08-19**; report shell exclusion recorded **2026-09-01**.
Repository evidence checked **2026-09-13**. The former baseline records `admin_only` recovery merged
**2026-08-04** and applied **2026-08-11**; this is dated evidence, not a new deployment verification.

## Context

Account data and billable AI operations require authentication, per-route authorization, and ownership
checks. Edge JWT verification alone cannot enforce application logout or administrator privileges.

## Decision

### Edge authentication

Cognito identities reach the private origin through CloudFront viewer-request Lambda@Edge. Verify
RS256 against JWKS and validate issuer, audience, token use, and expiry. Keep the
`awsops_token` cookie Secure, HttpOnly, SameSite=Lax, and scoped to `/`.

`terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl:is_public()` defines the exact public paths
and `/_next/static/*` prefix. Login, health, signout, approved static assets, and the separately
authenticated incident webhook are intentional exceptions. Any allowlist widening needs review.
The public manifest must remain constant, without user/session/environment data.

### Login and administration

The primary `/login` form calls `POST /api/auth/login`, which sends unsigned Cognito
`InitiateAuth(USER_PASSWORD_AUTH)` requests. It sets the Cognito ID token cookie, collapses account
existence errors, and sanitizes `next` redirects. The client permits password auth, has no client
secret, and does not enable refresh-token auth; the BFF does not implement token refresh.
ID/access token validity is 12 hours. Keep the Hosted UI PKCE/state callback as a dark fallback.

Admin authority is Cognito admin-group membership or the SSM email allowlist, resolved by
`web/lib/admin.ts` and failing closed. Public signup stays disabled
(`allow_admin_create_user_only=true`); client-writable attributes exclude email and email_verified.
Recovery is `admin_only`, including Hosted UI recovery: password resets are operator tasks.

`verifyUser()` adopts `email` only when `email_verified === true`; otherwise it omits email
while retaining valid sub-based access. SSM email-admin and legacy-owner matching use only this
adopted claim. A truthy string or an unverified address must not satisfy that gate.
Verify each email-admin account's `email_verified` state before relying on that access.
Changes to identity claims require a newly issued ID token; old claims can persist for its
12-hour lifetime. Re-login after claim changes. The separate SSM allowlist has a five-minute
per-container cache; changing that list is not itself a token-claim update.

### BFF authorization

Every data-returning/billable user route must call `verifyUser()` and enforce its own authorization
and ownership. The recorded carve-outs are `/api/db` (diagnostic metadata), `/api/stream` (ticks), and
`/api/incidents/webhook` (separate machine authentication, ADR-013). These are not permission for
new routes to omit verification. Public login/signout/health/static handlers have their own contracts.

### §2-4 Session revocation

Aurora `session_revocations` stores a monotonic per-sub cutoff. Signout advances it only to that
token's `iat`; `verifyUser()` rejects tokens with `iat <= revoked_at`. Signout checks signatures and
claims with a five-minute expiry tolerance, skips the revocation lookup, and clears the cookie.
Lambda@Edge stays JWT-only; revocation applies when the request reaches BFF verification.

Accepted availability tradeoff: a failed/timed-out revocation read fails open with logging and
CloudWatch alarms. The timeout is three seconds; successful cutoff lookups have a five-second
per-container cache. Failed reads are not cached. A signout invalidates its local cache entry;
other tasks can accept the old token until their cache expires. Do not describe logout as globally
instantaneous or fail-closed during Aurora failure.
Monitor `revocation_check_failed` and `revocation_write_failed` with the metric filters/alarms
in `workload.tf`; the former means revocation reads failed open, the latter means logout
could not persist the cutoff. These alarm bodies cite this §2-4.

### Immutable ownership and migration

New ownership writes use Cognito `sub`. Verified email matching is a temporary compatibility path
controlled by `legacy_email_owner_match` (default **true**) / `LEGACY_EMAIL_OWNER_MATCH`. It affects
both reads and report PATCH/DELETE through `matchesIdentity()`, not just display.

Do not disable it on the strength of a clean backfill plan. Complete the reviewed apply and verify
zero residual legacy rows. ADR-009 records the current empty-plan limitation; it is not an
exception to the applied-backfill requirement.
Reassigned mailboxes can still match legacy rows while the switch is on; verified email is not proof
of historical ownership. Follow `docs/runbooks/user-offboarding.md` for revocation, account removal,
allowlist cleanup, and schedule cleanup; this ADR does not duplicate the operational ordering.

## Consequences

The two-layer design rejects unauthenticated edge traffic and protects BFF state with revocation and
ownership. It adds database dependency and bounded logout propagation delay. Admin-only signup/recovery
reduces mailbox takeover paths but requires operator support. Historical email compatibility remains
a documented migration risk until the actual cutover completes.

## Six Pillars

Security: verified identity, scoped authorization, immutable ownership, and closed self-service recovery.
Reliability and Operational Excellence: bounded revocation failure behavior and observable controls.

## Evidence

`web/lib/{auth,admin}.ts`, `web/app/api/auth/`, `terraform/v2/foundation/{auth,edge,workload}.tf`,
`terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl`, and ADR-009/013.
