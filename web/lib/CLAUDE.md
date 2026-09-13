# Web Libraries

Read root [CLAUDE.md](../../CLAUDE.md),
[BASELINE.md](../../docs/decisions/BASELINE.md), and [web context](../CLAUDE.md).
Use source and colocated tests for domain contracts; do not copy module counts
or review-round history into instructions.

## Security and data

- `db.ts:getPool()` is the shared Aurora pool, using IAM authentication as
  `awsops_web` with a fresh token per connection. Use parameterized queries;
  `$1` bindings are expected. Do not create ad hoc application pools or use the
  master secret for web requests.
- `auth.ts` verifies RS256/issuer/audience/token-use and session revocation.
  `admin.ts` checks Cognito groups or the SSM allowlist, failing closed.
  New ownership writes use `user.sub`. `matchesIdentity()`/`ownerKeysForRead()`
  retain the governed legacy email migration window; display identity is not
  an authorization key. Follow BASELINE before disabling that window.
- `ssrf-guard.ts` and connector guards protect external requests. Keep credentials
  server-side and exclude sensitive raw fields from API responses.

## Runtime contracts

- Existing domain libraries make scoped live AWS SDK reads; these are valid BFF
  paths. Preserve per-scope caches, in-flight deduplication, pagination, deadlines,
  and explicit unavailable/partial results. Heavy analysis belongs in workers.
- `aws-data.ts:steampipeAvailable()` is intentionally always false. Its chat SQL
  and collector execution stays disabled even when batch inventory sync is on.
  Gateway/route inventories come from `route.ts`, the resolver, collector registry,
  and `scripts/v2/agentcore/catalog.py`.
- Metrics and log analysis must distinguish missing data from zero and disclose
  incomplete coverage. In ANFW/SG analysis, preserve attribution/coverage guards
  and the tested aggregation semantics; an observed hit is not automatically
  proof of exact rule attribution. Use `anfw*.test.ts` and `sg-analysis.test.ts`.
- `eks-incluster.ts` performs read-only Kubernetes requests. Do not introduce
  cluster write verbs. `jobs.ts` handles persistence/enqueue, not domain authorization.

## Localization and catalogs

`i18n.ts:SUPPORTED_LANGS` is the locale source. Keep affected agent/Bedrock language
maps, metric guides, worker report catalogs, and `diagnosis-sections.ts` aligned.
`i18n-coverage.test.ts` and worker mirror tests cover specific contracts; other
catalog changes still need inspection. `trend-utils.ts` also shares derived-series
contracts with the batch sync; check `test_sync_lambda_queries.py` when changing them.

`changelog.ts` reads root `CHANGELOG.md` (copied into the image by deployment).
The parser reads English-only documents. In legacy bilingual documents, fallback
applies when a whole Korean version section is missing, not an individual bullet.
Developer-doc language policy does not remove product i18n.

For Network Firewall evidence (`anfw-logs.ts`), `ruleHits: null` is unavailable,
not a confirmed empty result. `ruleHitsTruncated` makes absent SIDs unknown after
the merged join cap; `ruleHitsPartial` makes even present positive counts lower
bounds after a per-region cap. Preserve both flags and `alertCoverageComplete`.
