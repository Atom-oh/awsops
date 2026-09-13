# Web BFF

Policy and local instructions: [BASELINE](../decisions/BASELINE.md) and
[web/CLAUDE.md](../../web/CLAUDE.md). `web/` contains the Next.js App Router app,
served at `/` with `/api/*` endpoints and a standalone arm64 image.

## Request contracts

- [Auth and identity](02-auth.md) covers edge authentication, BFF re-verification,
  revocation, admin checks, and ownership. Keep those checks before data access
  or billable work.
- Aurora requests use [getPool()](../../web/lib/db.ts) with IAM DB authentication.
  Existing service-specific libraries also make bounded AWS SDK and read-only
  Kubernetes calls. These are implemented BFF paths, not architecture violations.
- Heavy diagnosis, compliance, and batch work uses
  [dedicated authorized enqueue routes](06-workers.md). Generic `POST /api/jobs`
  accepts only its noop allowlist. Caller-owned domain IDs and requester identity
  must be resolved server-side.
- [Chat](../../web/app/api/chat/route.ts) streams AgentCore/Bedrock responses and
  supports gated routing/synthesis. Candidate selection does not enable fan-out;
  both hybrid-routing and synthesis gates must be on. Chat's Steampipe SQL and
  collector execution remains disabled. See [AgentCore](05-agentcore.md).
- [Integration workflows](integration-workflows.md) distinguish datasource setup
  and probes, custom-agent selection, and manual report handoff from live delivery.
- [middleware.ts](../../web/middleware.ts) caps API bodies at 2 MB; route-specific
  `readJsonBounded()` limits remain necessary. Preserve status/error responses and
  explicit partial/unavailable data instead of returning healthy zeroes.

## Build and deployment

`web/package.json` defines dev/build/start/test; there is no lint script. From
`web/`, run `npm ci`, `npm run build`, and the relevant `npx vitest run` suites.
From the repository root, authorized deployment uses `make deploy`: migrate,
arm64 build/ECR push, ECS rollout, wait stable, and `/api/health` smoke.

[workload.tf](../../terraform/v2/foundation/workload.tf) must set
`HOSTNAME=0.0.0.0` in the task environment; image ENV alone is insufficient.
Container and target-group health paths both use `/api/health`. Runtime AWS API
permissions belong to the task role; any ECS secret injection uses execution-role
permissions. AgentCore settings are read from SSM at runtime.

The [deployment script](../../scripts/v2/deploy.mjs) copies root `CHANGELOG.md`
into the web build context. Its parser accepts English-only entries with an
English fallback. Product translations remain governed by `SUPPORTED_LANGS` and
existing localization contracts; developer-doc cleanup does not remove them.
