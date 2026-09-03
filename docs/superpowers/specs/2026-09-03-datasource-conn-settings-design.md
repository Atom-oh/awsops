# Per-datasource connection settings — 1 gap-audit item (L203)

**Status:** Batch 38, 2026-09-03 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/batch38`.
**WA pillar:** Operational Excellence / Performance Efficiency (per-instance query bounds).

Closes gap-audit item (docs/v1-gap-audit-2026-07-19.md): L203 (per-datasource Timeout /
Cache TTL / ClickHouse database — v1's Settings section).

## Decisions

- **Storage**: one `ds_settings JSONB NOT NULL DEFAULT '{}'` column on the `integrations`
  row (new ULID migration; additive + idempotent). Validated by `sanitizeDsSettings`
  (web/lib/datasources.ts) on WRITE and RE-VALIDATED on READ (a hand-edited DB row can't
  smuggle an out-of-contract value): `timeoutS` int 1..60; `database` bare identifier
  (`^[A-Za-z_][A-Za-z0-9_]*$`). Out-of-contract values are DROPPED, not errors (a stale
  client must not brick the form). Unknown keys never pass through.
- **Timeout (v1: request timeout ms → v2: seconds 1..60, disclosed unit change)** — the
  per-datasource `timeoutS` is the upstream query execution bound:
  - prometheus/mimir: forwarded as the API `timeout` param, additionally CAPPED at 10s —
    the connector's own HTTP timeout is 12s, so a longer upstream bound is dead config;
  - clickhouse: forwarded as `max_execution_time` (the connector clamps 1..60; its HTTP
    timeout is longer);
  - other kinds: no arg is sent (their connectors read none).
- **ClickHouse database** — rides `resolveConnConfig` (kind-gated: only clickhouse rows set
  it) → the connector appends `&database=` after ITS OWN identifier re-validation (defense
  in depth on both sides of the trust boundary; a bad identifier is a 400 before any HTTP).
- **Cache TTL: deliberately NOT ported (disclosed deviation)** — the v2 thin-BFF query path
  is uncached by design; a per-datasource result cache would need its own
  staleness-disclosure machinery (the repo's honest-degrade bar). Recorded in the gap-audit
  tick, the migration header, and the docs-site v1-difference note (4 locales).
- **Form**: a Settings section on the datasource form — Timeout (seconds, optional; empty
  clears) and, for kind=clickhouse only, Database. Settings ride both POST (create) and
  PATCH (update; absent key ≠ clear, `{}` clears). The list route exposes `settings` under
  the same admin-only visibility as `endpoint`.

## Testing
- sanitizeDsSettings contract (in/out-of-range, identifier, unknown keys, non-objects).
- manage route: settings ride create; PATCH passes settings only when present.
- query route: prometheus timeout override capped at 10s; clickhouse max_execution_time.
- clickhouse connector: `&database=` appended for a valid identifier; a non-identifier is
  rejected BEFORE any HTTP call (agent/lambda/test_clickhouse_mcp.py).
- form: settings payload (valid timeout sent, out-of-range dropped; Database rendered for
  clickhouse only).
- Full `npm test` + `tsc` + build + `pytest scripts/v2/{workers,steampipe}` +
  `pytest agent/lambda/test_clickhouse_mcp.py`; docs-site field tables corrected in 4
  locales (they described v1's fields as if live); CHANGELOG EN/KO; audit tick + note.
