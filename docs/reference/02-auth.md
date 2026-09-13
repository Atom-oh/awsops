# Auth and Identity

Policy: [BASELINE](../decisions/BASELINE.md) and
[ADR-002](../decisions/002-auth-and-login.md). Authentication is enforced at the
edge and reverified by the BFF; authorization and session revocation are BFF controls.

## Login and edge

[auth.tf](../../terraform/v2/foundation/auth.tf) defines an admin-create-only
Cognito pool with `admin_only` account recovery. The public app client has no
client secret, permits password authentication, and restricts writable attributes
to `name`. Read access to verified email supports the ownership migration window.

The checked-in pool has `mfa_configuration = "OFF"` and a minimum password length
of eight, requiring uppercase, lowercase, and numbers but not symbols. This
accepted residual risk remains: closed signup, admin-only recovery, and request
checks do not provide a second factor against a compromised password.

The self-hosted `/login` form submits to
[POST /api/auth/login](../../web/app/api/auth/login/route.ts).
[login.ts](../../web/lib/login.ts) calls unsigned Cognito `USER_PASSWORD_AUTH`,
returns the ID token as `awsops_token`, and validates the next-page redirect.
The cookie is Secure, HttpOnly, SameSite=Lax, and root-scoped. Remember-me adds
`Max-Age` from the token lifetime; otherwise it is a session cookie. Refresh-token
handling is not implemented. Current ID/access lifetimes are declared in `auth.tf`.

The [edge template](../../terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl)
checks RS256 against JWKS and validates issuer, audience, token use, and timestamps.
`is_public()` is the authoritative public-path allowlist; additions require review.
The Hosted UI `/_callback` path retains OAuth state and PKCE as a fallback. Edge
configuration is rendered by Terraform and attached via the published function
version. Diagnose edge rejection separately from origin failures.

The exact `/api/incidents/webhook` exception supports machine senders without a
Cognito cookie; the route verifies SNS signatures and topic allowlists, or direct
bearer/HMAC credentials. PWA manifest/icons must also load without a cookie.
[`manifest.test.ts`](../../web/app/manifest.test.ts) keeps manifest assets, public
files, and the edge allowlist in step; neither exception permits widening the allowlist.

## BFF checks and revocation

[auth.ts](../../web/lib/auth.ts) verifies RS256/issuer/audience/ID-token use again,
requires `sub`, and checks `session_revocations`. Decode-only handling is not the
current contract. Private data and billable routes call `verifyUser()`; root policy
keeps narrow diagnostic exceptions for `/api/db` and `/api/stream`, and alternate
authentication for the incident webhook. The diagnostic routes remain edge-protected.
Login/signout/health have their own entry-point contracts.

Signout clears the cookie and attempts a monotonic revocation update bounded to
the signing-out token's own `iat`; replay cannot revoke newer sessions. Tokens
with `iat <= revoked_at` remain revoked, including same-second re-login tokens.

Revocation queries have a 3-second application/statement deadline and a 5-second
per-container successful-result cache. Database failures deliberately fail open
with a `revocation_check_failed` event; failed reads are not cached. This is an
availability tradeoff, not fail-closed revocation. Missing token `iat` fails closed.
Signout tolerates only the bounded expiry window in `verifyUserForSignout()` and
still verifies signature and claims.

## Authorization and ownership

[admin.ts](../../web/lib/admin.ts) uses the Cognito admin group or SSM email
allowlist and fails closed. New ownership records use immutable `user.sub`.
`matchesIdentity()` and `ownerKeysForRead()` preserve verified-email matches while
`legacy_email_owner_match` is enabled. Disable it only after the applied backfill
confirms zero legacy owner rows; a preview alone is insufficient.

Useful checks: `web/lib/auth.test.ts`, `web/lib/login.test.ts`, and route tests.
Operational procedures: [auth issues](../runbooks/cognito-auth-issues.md) and
[user offboarding](../runbooks/user-offboarding.md).
