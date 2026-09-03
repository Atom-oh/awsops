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
  - clickhouse: applied as `max_execution_time` via the conn config (effective maximum 55s —
    the connector aligns its HTTP timeout at bound+3s under the Lambda's 60s wall; as amended
    by round 1);
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

## Round-1 corrections (review-driven)

- **`database=system` cannot bypass the lexical read-only guard (the L3 gate MAJOR)** —
  `system`/`information_schema` (case-insensitive) are rejected in BOTH `sanitizeDsSettings`
  and the connector's pre-URL check: with `database=system`, an unqualified `FROM tables`
  would resolve to `system.tables` (create_table_query/engine_full can carry plaintext engine
  credentials) with no `system` token in the SQL for the guard to see. Pre-HTTP regression
  tests pin both spellings.
- **The ClickHouse bound is honest end-to-end (the L2/L4 gate MAJORs)** — the round-0 comment
  claiming "its HTTP timeout is longer" was FALSE (shared `HTTP_TIMEOUT = 12`); values 13–60
  were dead config, and an unset setting left the scan unbounded despite the documented
  default. Now: `timeoutS` rides the conn config/secret blob; the CONNECTOR owns the default
  (10s when nothing is configured — never an unbounded scan), clamps to 55s, and aligns its
  own HTTP timeout at bound+3s (under the Lambda's 60s wall) so the server-side bound always
  fires first. One mechanism covers Explore, the service-graph sources
  (ClickHouseOtelTraceSource/MetricsCallsSource resolve the same conn config), and the
  agent/worker secret path (settings ride the per-instance blob — non-secret config, the
  connector stays credential-blind). The Explore route no longer sends a ClickHouse arg.
- **Claims narrowed to the real coverage (the L4/L5 gate MAJORs)** — CHANGELOG/spec/docs now
  say: ClickHouse bound on every path; Prometheus/Mimir bound on the Explore path (API
  `timeout` param, capped at 10s under the 12s connector HTTP timeout). The docs-site
  "설정 참조" section (4 locales) — which still advertised v1's 30s/120s/cacheTTL semantics —
  is rewritten to the shipped contract.
- Minors: `sanitizeDsSettings` type-checks instead of coercing (`'30'`/`true` are dropped);
  the settings-only PATCH also rewrites the per-instance secret blob so the agent path never
  reads a stale bound.

## Round-2 corrections (review-driven)

- **A settings-only PATCH no longer destroys the credential (the gate MAJOR)** — the round-1
  change made settings edits rewrite the secret blob, but the blob was RECONSTRUCTED from
  scratch (`setIntegrationCredentialById` is a full replace): a timeout edit wiped the stored
  username/password/token/headers and, for a default instance, `updateDatasource` mirrored
  the de-authenticated blob to the kind key the agent path reads. The PATCH now MERGES onto
  the existing blob (`getCredentialById(id)` spread first, then endpoint/authType/creds/
  settings) — which also fixes the PRE-EXISTING endpoint-only variant of the same wipe. A
  regression test pins that stored auth material survives a settings-only PATCH.
- Minors: a database change on PATCH triggers the connect-time schema warm (POST parity —
  AI query generation re-grounds on the new database without waiting for the 6h staleness
  TTL); the connector identifier check uses `re.fullmatch` (Python's `$` matches before a
  trailing newline) and both layers bound the database length at 128; the ClickHouse
  EFFECTIVE maximum (55s — Lambda-wall alignment shortens 56–60s) is disclosed in the docs
  (4 locales), api-reference, and this spec's Decisions section. The prometheus/mimir 10s cap
  was already disclosed (round 1).
