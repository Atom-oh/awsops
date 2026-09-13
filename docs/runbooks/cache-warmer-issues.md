# Diagnose stale data and caches

The old v1 `src/lib/cache-warmer.ts` and `/awsops/api/steampipe?action=cache-status`
endpoint are retired. Do not restart embedded PostgreSQL or use those endpoints to
repair v2 freshness.

Identify the failing data plane first:

| Symptom | Check |
| --- | --- |
| Inventory is old | `inventory_sync_runs.status`, `last_success_at`, and `unknown_attribute_count`; account scope and retained inventory capture timestamps |
| Live metric panel is empty | Source permissions, selected scope/window and explicit source error/degraded state |
| Datasource schema is incomplete | `datasource_schemas.fetched_at` and schema coverage/truncation metadata, connector discovery limits and the admin refresh path |
| App state is unavailable | Aurora configuration/connectivity and application logs |

Preserve last-good inventory after failed/partial collection. Do not hide degraded
or unknown attributes, claim success from HTTP 200 alone, or delete durable rows to
force a refresh. Manual inventory refresh uses the same governed asynchronous sync
path and does not bypass concurrency limits.

Follow [Steampipe quota and staleness](steampipe-quota-and-staleness.md),
[Tempo query generation](tempo-query-generation.md), and
[ADR-014](../decisions/014-cross-cutting-cache-i18n-cdn.md) for the relevant cache.
