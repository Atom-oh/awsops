# Add a dashboard page

A v2 page lives under `web/app/`; APIs use `/api/*`. The retired `src/`,
`/awsops/api/steampipe` and local JSON patterns are not templates for new work.

1. Identify the resource/data contract in Aurora, the existing domain API or a
   read-only MCP tool. Check baseline schema **and** migrations. Never add live
   Steampipe SQL to a request handler; the gated backend supports batch work.
2. Reuse the nearest page and shared components under `web/components/`.
   Default-export page components and preserve existing named shared exports.
   Use semantic theme tokens and existing loading/empty/error patterns.
3. Apply account/region scoping server-side. New data/billable routes use
   `verifyUser`, revocation and owner/admin checks; do not expand edge public paths
   merely to make a fetch succeed.
4. Enqueue heavy work through an ownership-checked domain route. Generic `/api/jobs`
   is intentionally limited to noop types.
5. Add navigable pages to the existing sidebar configuration. Preserve product
   translations and accessible labels. Display freshness, missing evidence and
   time windows; an unavailable collector is not zero healthy resources.
6. Run relevant Vitest tests and the production build. Update the covering
   changelog entry if it does not already describe the net behavior, and update
   the relevant implementation reference when behavior changes.
   Do not add hand-maintained page/component counts to context files.

```bash
(cd web && npx vitest run)
(cd web && npm run build)
```

Sources: `web/app/CLAUDE.md`, `web/components/CLAUDE.md`, `web/lib/CLAUDE.md`,
[UI design](../../DESIGN.md), [ADR-001](../decisions/001-v2-foundation.md).
