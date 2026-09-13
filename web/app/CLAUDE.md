# App Routes

Read root [CLAUDE.md](../../CLAUDE.md),
[BASELINE.md](../../docs/decisions/BASELINE.md), and [web context](../CLAUDE.md).
Discover current pages/API handlers from this directory; do not maintain counts
or duplicate inventories in instructions.

- Private data and billable handlers call `verifyUser()` before work. Preserve
  BFF revocation/ownership checks and `isAdmin()` on admin operations.
  Edge authentication and BFF authorization are separate boundaries.
- The edge public-path source is
  `terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl:is_public()`.
  Preserve its narrow allowlist. Root policy defines BFF carve-outs: diagnostic
  `api/db` and `api/stream`, and alternate-auth machine ingress at
  `api/incidents/webhook`. Login/signout have their own authentication contracts;
  do not apply a generic session check blindly or expand an exemption.
- Use `readJsonBounded()` for JSON bodies and preserve the middleware cap.
  Keep existing `force-dynamic`/cache behavior when changing handlers.
- Submit domain work through its dedicated authorized route. Generic `api/jobs`
  is limited to its noop allowlist; do not expose arbitrary worker job types.
- `api/chat/route.ts` owns dispatch. Steampipe SQL/collector branches remain
  hard-disabled and return to normal routing. Multi-gateway synthesis requires
  both hybrid-routing and synthesis gates; it excludes local collector handlers.
- Fetch `/api/*`. Add `'use client'` only where browser state/APIs require it;
  server layouts and metadata exports are established patterns.
- Register new navigable pages in `components/shell/Sidebar.tsx` with the required
  i18n keys. Preserve app localization when updating English developer docs.
