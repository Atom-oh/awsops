# Library Module

## Role
116 domain-logic modules shared by API routes and components, mostly React-free (includes `collectors/`). Tests colocated with source, vitest.

## Key Files
- `db.ts` — Aurora node-pg shared pool `getPool()`: RDS IAM DB auth (`awsops_web` role, not the master secret). `password` is passed as a function so each connection signs a fresh 15-minute token — safe across the 7-day secret auto-rotation. `max: 3`.
- `auth.ts` — `verifyUser()`: re-verifies the `awsops_token` cookie via RS256 JWKS, alg pinning + `token_use==='id'`.
- `aws-data.ts` — Steampipe SQL layer behind the chat `aws-data` route: LLM generates a SELECT (one self-correction pass) → live execution (SELECT-only guard, 200-row cap, dedicated small pool `max: 2` + `statement_timeout: 35s` — raised from measured cold multi-region wide-scan latency) → row-based Bedrock analysis stream. **Sonnet-5 responses can start with a thinking block — never assume `content[0]` is the text block; read all text blocks.** History turns starting with an assistant ⚠️ fallback are excluded from the SQL-generation context — guards against history contamination that misleads the model into thinking tools are unavailable.
- `collectors/` — registry of the 6 auto-collect collectors (idle-scan, eks/db/msk-optimize, trace-analyze, incident). One line registered in `COLLECTORS` adds a chat route — `chat/route.ts` branches through a single generic `collectorByKey`.
- `nfm.ts` / `dns-logs.ts` / `ip-inventory.ts` / `tgw.ts` / `vpce.ts` / `dx.ts` — shared pattern for the live-AWS-query layer: **4-minute TTL cache + in-flight promise dedupe** (concurrent requests for the same key share the in-flight promise). Degrades honestly to `available:false` / onboarding guidance when the resource is absent.
- Per-file traps: `nfm.ts` live-query range is capped at 1h (`NFM_MAX_RANGE_SEC` — measured API `ValidationException`; longer ranges need a collection pipeline) · `dns-logs.ts` Logs Insights `parse` does server-side aggregation — `@message` is raw JSON text, so inner quotes are escaped as `\"` and the regex must match that · `vpce.ts` detects unused (idle-billed) Interface endpoints via `AWS/PrivateLinkEndpoints` BytesProcessed == 0 / missing series · `tgw.ts` — TGW is a regional resource, requires an EC2 client per owning region; using only the default region silently returns empty results · `dx.ts` — hosted (<1G) connections don't publish connection-level Bps, so VIF-level metrics are used instead; `VirtualInterfaceUtilization*` publishes as a percentage (measured/verified); the VIF response's `authKey`/`customerRouterConfig` are sensitive — never put them in a row.
- `i18n.ts` — `SUPPORTED_LANGS = ['ko','en','zh','ja']` is the single source of truth. 3 hand-maintained lockstep sites the compiler can't catch: the `agent/agent.py` language-instruction map, the `bedrock-direct.ts` lang ternary, `components/inventory/metrics/guides.<lang>.tsx`.
- `i18n-terms.ts` — `tt(label)`: the Korean literal is the source string; an unregistered string passes through unchanged (zero-risk fallback). Parameterized patterns go through RULES.
- `eks-incluster.ts` — direct K8s API calls (reproduces `aws eks get-token`, P1e Access Entry + AdminViewPolicy). **Read-only invariant: GET only, never issue a write verb.** 4s timeout per request, 50-minute AssumeRole cache.
- `inventory-types.ts` — inventory type registry (`InvType` spec — backs DetailPanel's `sections`).
- `jobs.ts` — worker job creation/lookup (`worker_jobs` + SQS enqueue).
- `changelog.ts` — data layer for the sidebar version chip + changelog modal (server-only, fs). **Single source of truth = repo-root `CHANGELOG.md`** — `deploy.mjs` copies it into the image just before build (`/app/CHANGELOG.md`); local dev falls back to `../CHANGELOG.md`. Bilingual (# English / # 한국어).
- `ssrf-guard.ts` — SSRF guard for external datasource calls.

## Rules
- New live-AWS-query layers should clone `nfm.ts`'s TTL-cache + in-flight-dedupe pattern.
- Adding/changing a language starts at `SUPPORTED_LANGS` — TS consumers break at compile time, but the 3 lockstep sites above require manual updates.
- DB access must go through `getPool()` — never create a new pool or use the master secret.
