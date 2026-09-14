# Diagnose Cognito login and session failures

v2 uses a **public client without a client secret**. The self-hosted `/login` form
calls `POST /api/auth/login`; the BFF uses Cognito `USER_PASSWORD_AUTH`. Do not add a
client secret or `SECRET_HASH` to repair a configuration mismatch.

## Verify the failing boundary

| Symptom | Verification |
| --- | --- |
| Login reports missing configuration | Check the presence and correct pool/client/region in task configuration; compare `web/lib/login.ts` and `auth.tf`. Do not print environment secrets. |
| Credentials rejected | Check user status, enabled password-auth flow and closed admin-created-user lifecycle in Cognito. Do not enable public signup or self-service recovery. |
| Edge rejects a token | Check issuer, audience, token use, expiry and RS256/JWKS verification in the deployed edge function. Keep signature verification enabled. |
| Login redirects repeatedly | Inspect browser cookie attributes and request host/path without sharing cookie values; compare login and edge configuration. |
| Signed-out session still accesses data | Check the BFF session-revocation path and route authorization; edge JWT validity alone does not establish an active session. |

Request path: browser -> CloudFront/Lambda@Edge -> VPC Origin -> internal ALB ->
Fargate web. The edge function is managed in us-east-1; inspect logs in the region
where the request executed, using its actual replicated function/log group.

`POST /api/auth/signout` expires the HttpOnly cookie server-side. JavaScript cannot
remove that cookie directly. Hosted UI PKCE is a retained fallback; it is not the
primary login flow. Check the exact public-path allowlist before blaming the ALB.

Use [user-offboarding.md](user-offboarding.md) for removing a user's access and
scheduled work. Do not infer that deleting a browser cookie revokes all sessions.

Sources: `web/lib/login.ts`, `web/lib/auth.ts`, `web/app/api/auth/`,
`terraform/v2/foundation/auth.tf`,
`terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl`,
[ADR-002](../decisions/002-auth-and-login.md).
