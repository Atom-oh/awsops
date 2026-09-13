# Web

Read root [CLAUDE.md](../CLAUDE.md) and
[BASELINE.md](../docs/decisions/BASELINE.md) for policy. The Next.js App Router
application serves `/` with `/api/*` fetch paths and a standalone arm64 ECS image.
`package.json`, `next.config.mjs`, and `Dockerfile` define the build/runtime.

From `web/`:

```bash
npm ci
npm run dev
npm run build
npx vitest run
```

There is no lint script. Tests are colocated as `*.test.ts(x)`; use the relevant
suite for targeted changes. Deploy through `make deploy` from the repository
root. Web tasks require runtime `HOSTNAME=0.0.0.0` and `/api/health` checks.

## Boundaries

- `POST /api/deployment/readiness` requires an admin or deployment-verifiers membership,
  one in-flight call and a 60-second process cooldown. It verifies the actual web-role
  STS identity and three fresh AgentCore SSM reads, and accepts only a nonce/account-bound
  runtime readiness response. Disabled, pending, denied or missing dependencies fail
  explicitly; normal chat fallback is not readiness evidence.
- `lib/agentcore-config.ts` rejects invalid runtime ARNs before caching; an explicitly
  empty runtime parameter disables discovery. Inventory summaries expose aggregate job
  collection ledger metadata through `lib/inventory-collection.ts`, preserving missing
  runs and unknown attributes separately from region-filtered resource counts.

- BFF handlers use Aurora via `lib/db.ts:getPool()`, existing scoped AWS SDK reads,
  read-only Kubernetes APIs, and AgentCore. Heavy/long-running work belongs in
  the worker tier. Generic `POST /api/jobs` accepts its noop allowlist; domain
  jobs use their dedicated authorized, ownership-checked routes.
- Preserve JWT verification, BFF session revocation, admin checks, and sub-based
  ownership. See [app/CLAUDE.md](app/CLAUDE.md) and [lib/CLAUDE.md](lib/CLAUDE.md).
- Keep credentials server-side. App state is in Aurora, not local JSON files.
  AgentCore runtime configuration is read from SSM.
- Preserve middleware/body-reader limits and dynamic-route caching behavior.
  `instrumentation.ts` controls the gated background graph rebuild.
- Components follow existing exports/props; named shared helpers are valid.
  See [components/CLAUDE.md](components/CLAUDE.md).
- Developer/reviewer docs are English-only. Application translations, language
  selection, and localized report generation remain intact.

Host-only inventory rejects account onboarding before STS/database writes. Existing reads,
connection tests and deletion retain their behavior.
