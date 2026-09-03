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

## Round-3 corrections (review-driven)

- **`settings:{}` genuinely clears (the gate MAJOR)** — the round-2 blind merge left cleared/
  superseded settings keys live in the credential blob (and, cred-first, they leaked through
  `resolveConnConfig` and the agent path). The PATCH now strips the settings keys from the
  existing blob whenever the request carries `settings`, and `resolveConnConfig` deletes
  `database`/`timeoutS` from the cred before overlaying the ROW's settings — the row is
  authoritative on every path. Regression tests pin both layers.
- **Auth material never follows an endpoint HOST change (the gate MAJOR)** — the round-2
  merge would have transmitted stored write-only credentials to any newly pointed host on
  the next query. Auth keys are now dropped on a host change unless creds are re-supplied
  (fail-safe: the next query is unauthenticated against the new host — never a leak), and an
  authType downgrade prunes residue keys (basic→none leaves nothing in Secrets Manager).
  Disclosed semantics: same-host endpoint edits keep the credential; host changes require
  re-entering it.
- **The configured ClickHouse bound is a CEILING (the gate MAJOR)** — a caller-supplied
  `max_execution_time` (agent tool call, the worker dry-run's pinned 5s) can only TIGHTEN
  the admin's bound, never exceed it; docs/CHANGELOG restate 'applies on every path' as the
  ceiling semantics (4 locales). Connector tests pin both directions.
- Minors: an out-of-range form timeout is a visible inline error that blocks save (a typo no
  longer silently clears the stored value); clearing the database also triggers the schema
  re-warm; noted, not shipped — the manage-route tests stub the sanitizer (real enforcement
  is covered by the lib/connector tests).

## Round-4 corrections (review-driven)

- **The host-change guard survives the real UI path (the gate MAJOR)** — the shipped form
  always sends `creds` (possibly `{}`), which round 3's `creds === undefined` check treated
  as "re-supplied", keeping stored auth material on a host edit from the UI. "Re-supplied"
  now means ACTUAL auth keys present (`AUTH_KEYS.some(k => k in creds)`); tests pin the
  `creds:{}` UI shape and the genuinely-re-supplied shape.
- **A migrated-default instance is never de-authenticated (the gate MAJOR)** — the merge
  base now falls back to the kind mirror for a default instance
  (`getCredentialById(id, ds.isDefault ? ds.kind : undefined)`): a settings-only PATCH on a
  row whose credential lives only under the kind mirror previously produced an empty merge
  base, wrote a de-authed id-keyed blob, and updateDatasource then mirrored that over the
  working kind mirror (silent, unrecoverable — creds are write-only). The kind mirror is
  additionally re-mirrored with the POST-merge blob after the write.
- Minors: ORIGIN compare (scheme+host+port — an https→http downgrade counts as a change, no
  cleartext Basic transmit); `org_id` is dropped with the auth keys on a host change
  (tenant id is host-scoped); settings keys are stripped from the merge base UNCONDITIONALLY
  (an endpoint-only PATCH carries no historical stale timeoutS/database); the row update runs
  BEFORE the blob write/schema warm (a duplicate-name 409 no longer leaves a half-committed
  secret).

## Round-5 corrections (review-driven)

- **The host-change guard is unconditional (the gate MAJORs, collapsed)** — round 4's
  "re-supplied" heuristic was bypassable by a PARTIAL creds object ({username} carried the
  stored password to the new origin). On a host change, ALL credential keys (org_id included)
  are now dropped from the merge base unconditionally; whatever the client genuinely
  re-supplied is reinstated by the creds spread. And `creds` is KEY-ALLOWLISTED
  (`pickCredKeys`: auth keys + org_id only) in POST and PATCH, with the validated
  endpoint/authType placed AFTER the spread — `creds.endpoint`/`creds.database` can no longer
  smuggle values into the blob (that injection became credential exfiltration only once the
  merge existed).
- **Leak-safe write order (the gate MAJOR)** — the sequence is now: name preflight (the only
  unique-constraint field — a duplicate-name 409 commits nothing) → credential strip/rewrite →
  row update → mirror refresh. If the secret write fails, the row still points at the OLD
  host (old creds never transmit to the new one); if the row update fails after the blob
  write, the stripped blob is fail-safe (unauthenticated), never a leak.
- Minors: the ClickHouse Database field gets the same inline validation as the timeout
  (identifier + system rejection — a typo errors visibly instead of silently clearing); the
  guide's two still-true limitation facts (SELECT-only guard, 1,000-row cap) are restored in
  4 locales (the deleted section's "private IPs blocked" claim was false and stays out —
  ADR-007 deliberately allows private datasource endpoints).

## Round-6 corrections (review-driven)

- **The URL-parser differential is closed (the gate MAJOR)** — WHATWG `URL` (the Node-side
  SSRF guard and origin compare) treats `\\` as a path separator while the Python connector's
  urlparse reads the authority to the `@`: `http://victim:9090\\@attacker:9091` matched the
  stored origin on the Node side yet connected (with retained credentials) to the attacker
  host on the Python side. `assertDatasourceEndpointAllowed` now rejects ANY endpoint
  containing a backslash (no legitimate endpoint has one); regression tests pin the shape on
  the guard and the PATCH. (Round-7 correction: this covers the datasource manage/test paths —
  the generic /api/integrations upsert writes endpoints through assertEgressEndpointAllowed,
  which now carries the same backslash rejection; the pre-existing endpoint-rewrite-without-
  credential-scrub gap on that path remains the recorded follow-up.)
- Minors: a non-empty settings object that sanitizes to EMPTY is a 400 (a fully-invalid
  direct-API payload must not read as an explicit clear — the manage tests now use the REAL
  sanitizer logic instead of a pass-through stub); the connector blocks a query-level
  `SETTINGS` token outright (readonly=1's changeable_in_readonly nuance is a server-profile
  detail — belt over suspenders, test pinned); the guide's Timeout row states that
  Loki/Tempo/Jaeger/Dynatrace/Datadog store but do not yet apply the value (4 locales).
- Out-of-diff cleanups folded in (the same guide contradicted this PR's own corrections two
  sections up): the v1 `adminEmails` admin model and the false "private IPs blocked" claim
  corrected in 4 locales, the v1-only "Allowed Networks" section gets a v1-legacy caution,
  and the stale "7 datasource kinds" count → 8 (Mimir).
- Recorded follow-up (pre-existing, out of scope): apply the origin compare inside
  `resolveConnConfig` (a row-endpoint change via the generic /api/integrations upsert path
  carries stored creds at query time — predates this PR); the deprecated slug query path does
  not load per-instance timeoutS (tighten-only gap, no UI caller).

## Round-7 corrections (review-driven)

- **The SETTINGS guard is scoped to bound-relaxing settings (the gate MAJOR)** — round 6's
  blanket `\bSETTINGS\b` block broke PERSISTED service-graph templates
  (`graph_querygen` emits `... LIMIT {cap} SETTINGS max_rows = {cap}`, a pinned supported
  shape; the graph source converts the connector 400 to `[]`, silently emptying graphs). Only
  `max_execution_time`/`max_result_rows`/`readonly`/`timeout_overflow_mode` inside a SETTINGS
  clause are rejected now; a connector test pins both directions (bound-relaxing blocked, the
  persisted template shape passing).
- **The DEFAULT is the ceiling too (the gate MAJOR)** — with no configured `timeoutS`, a
  caller-supplied `max_execution_time=55` bypassed the documented 10s default bound (the
  `elif configured:` clamp never ran). `configured or 10` is now the ceiling in every case;
  test pinned.
- Minors: `assertEgressEndpointAllowed` carries the same backslash rejection (the round-6
  "central" claim is corrected — the generic /api/integrations upsert writes endpoints through
  that guard); the pre-existing endpoint-rewrite-without-scrub and query-string/fragment
  hardening remain recorded follow-ups.

## Round-8 corrections (review-driven)

- **Non-object settings shapes are a 400 (the gate MAJOR)** — `settings: null/[1]/"x"/5`
  bypassed the round-6 object-only empty-sanitize guard and read as an explicit clear.
  A present `settings` that is not a plain object is now rejected in POST and PATCH before
  any write; test pins all four shapes.
- **The EN guide's intro line joins the 7→8 correction (the gate docs item)** — the round-6
  sweep fixed ko/zh/ja intros and all four field tables but missed the EN intro bullet
  ("**7 datasource types**" with no Mimir), leaving the page self-contradicting.
- Minor: the SETTINGS check runs on comment/string-STRIPPED text — a block comment can no
  longer smuggle a ';' past the clause window (`SETTINGS /* ; */ max_execution_time=0`), and
  a string literal containing the words is no longer a false positive (both test-pinned;
  ClickHouse block comments do not nest, matching the shared guard's dialect setting).
- Recorded follow-ups reaffirmed (pre-existing, next batch candidates): origin compare inside
  resolveConnConfig for the generic /api/integrations endpoint-rewrite path; connector-side
  backslash re-rejection / stored-endpoint scan; query-string/fragment stripping on
  datasource endpoints; row-level locking for concurrent admin PATCHes.

## Round-9 corrections (review-driven)

- **The `#` line comment can no longer bypass the SETTINGS guard (the gate MAJOR)** —
  ClickHouse treats `#` as a line comment (the shared guard's own hash_comment dialect flag),
  so `SETTINGS # ;\nmax_execution_time=0` smuggled a ';' past the clause window inside an
  un-stripped comment. `_SQL_NOISE` now strips `#` comments too, and — per the round-9
  quoted-identifier convergence — double-quoted text stays VISIBLE to the regex
  (`"max_execution_time"` is an IDENTIFIER in ClickHouse, not a string; stripping it blinded
  the check). Tests pin all comment forms (`/* */`, `--`, `#`) and the quoted/backticked
  setting names; a single-quoted string literal still passes.
- **Mimir joins the guide's supported-datasources table and frontmatter (the docs item)** —
  the 7→8 sweep fixed the intro bullets and field tables but left the per-kind table and the
  frontmatter description without Mimir in all 4 locales (self-contradicting page).
- Minors (defense in depth, per the panel's suggestions): the kind-mirror merge base is
  trusted only when its endpoint ORIGIN matches the row's (a theoretically poisoned mirror
  can't bind a foreign credential to this endpoint — no reachable path was constructed, belt
  only); the Python connector re-rejects backslash endpoints (`assert_host_allowed`) so a
  PRE-EXISTING stored endpoint can't exploit the parser differential either.

## Round-10 corrections (review-driven)

- **The manage read→merge→write span is serialized (the gate MAJOR)** — the round-3 merge
  introduced a route-level race the credential store's per-write advisory lock does not
  cover: an interleaved settings-only PATCH (merge base read before a host-change scrub,
  written after it) could restore stripped auth material onto a row now pointing at the new
  host — deliberate exfiltration by racing two PATCHes. `withDatasourceLock(id, fn)` holds a
  per-datasource pg advisory lock on one pooled connection across the WHOLE span, and the
  row is re-fetched INSIDE the lock so the merge always starts from the latest committed
  state (unit test pins lock/unlock/release on success and throw).
- **The SETTINGS check uses the shared tokenizer (the gate MAJOR)** — the round-8/9 regex
  stripper was a sequential alternation, desyncing on a quote inside a backtick identifier
  (`` SELECT 1 AS `a'`, ... SETTINGS max_execution_time=0 --' `` swallowed the clause into
  the trailing comment) — the exact failure mode sql_readonly_guard's docstring warns about.
  The check now runs on `strip_sql(sql, hash_comment=True, nested_block_comment=False)`
  (single left-to-right tokenizer; identifier inner names stay visible per round 9); the
  desync PoC is test-pinned.
- Minors: auth-key pruning applies to the FINAL blob too ({authType:'none',
  creds:{password}} no longer re-adds residue after the merge-base pruning); `database`
  never persists for non-ClickHouse kinds; the connector's backslash re-rejection raises
  `SsrfBlocked` below the docstring (it had displaced `__doc__` and used the wrong exception
  type); the write-order comment discloses the residual re-supplied-creds-to-old-host window
  instead of claiming "never a leak" absolutely.
