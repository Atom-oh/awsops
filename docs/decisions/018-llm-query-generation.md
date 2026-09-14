# ADR-018: Read-Only Query Generation

## Status

Accepted. Worker graph and diagnostic-signal fallbacks remain **GATED, default false**.
Amended **2026-09-04** to document the already-implemented, ungated, user-requested Explore draft
path; amended **2026-09-12** for TraceQL validation/metadata. The **2026-08-06** connector attribution
correction remains reflected below. Repository evidence checked **2026-09-13**; no new permission granted.

## Context

A deterministic catalog can miss an instance's schema. Model-generated queries can supply a starting
point, but automatic worker dry-runs and user-requested drafts have different consent, execution,
validation, and budget contracts. Neither should inherit controls merely because another path has them.

## Decision

### A. Worker fallback contract

`graph_querygen_enabled` and `diag_signal_querygen_enabled` are separate default-off flags and require
`datasource_diagnosis_enabled`. Only invoke their fallback when the deterministic catalog has no ready
result for its scope. Send schema identifiers, not source rows or credentials, to Bedrock; generate one
candidate, validate it, and dry-run through the existing read-only connector before caching by schema version.
Do not cache error/empty dry-run results. Deterministic Tempo catalogs are not LLM-generated artifacts.

**§A-4 — Schema-version cache:** reuse validated worker artifacts for the same schema version;
do not regenerate them on every execution.

The shared connector transport calls `agent/lambda/datasource_http.py:assert_host_allowed` for
destination checks. ClickHouse additionally enforces SQL/read-only
and table-function restrictions; other kinds use their read endpoints. The graph and signal paths use
the same ClickHouse connector. Generator-level checks differ: signal generation blocks table functions
and SETTINGS before execution; graph generation relies on the connector for that surface.

### B. Diagnostic-signal fallback

`scripts/v2/workers/diagnosis/signal_catalog_gen.py` governs the signal fallback.
With the signal-generation flag enabled, every wired connector kind whose deterministic catalog
has zero ready rows is eligible for the fallback in `datasource_index.py`, subject to the
per-instance budgets below. Generated chips retain their `provenance='generated'` label.
The following controls apply across those kinds:

- Sanitize/bound prompt identifiers; require an expression that mentions the instance's vocabulary
  and is not a constant. The relevance check is heuristic, not a complete query parser.
- Bound dry-runs: ClickHouse execution/row limits, Prometheus/Mimir timeout, Loki/Tempo result limit.
  Loki/Tempo lack an equivalent server-side execution-time bound on this path; do not describe a
  result limit as a timeout. Empty data is transient, not permanently rejected.
- **§B-4 — Cost budget:** at most **three attempts per instance per ISO week**. After three consecutively exhausted
  weeks, park until schema change is recognized at a later week boundary. Same-week schema churn
  cannot reset the budget; disabled periods do not spend attempts.
- Store budget state in `__diag_signal_budget__` / `meta.budget`, separately from content schema
  versions. Pending/exhausted/conclusive states preserve consumed attempts and exhaustion streaks;
  a settled unchanged schema stays settled across weeks. Legacy-marker migration must not relabel
  stale content as the current schema or reset a still-current weekly budget.
- Generated rows are Explore chips only, excluded from report `_signal_plan` decisions. Enforce the
  flag on both worker generation and BFF reads; an inactive worker cannot be relied on to sweep
  cached rows after disablement. Retained validated content is not authority to bypass the flag.

### C. ClickHouse graph fallback

The `workers.tf` precondition directly requires `agentcore_enabled` for `graph_querygen_enabled`,
in addition to §A's datasource prerequisite. The precheck reads the provisioned interpreter ID from
SSM; an absent/unavailable interpreter skips the advisory check, not the connector validation.

`scripts/v2/workers/graph_querygen.py` is scoped to one `trace_spans` graph query. It checks required
aliases, performs a `LIMIT 1` dry-run, and can use an advisory Code Interpreter precheck when configured.
It does **not** have the signal path's identifier sanitation, relevance gate, weekly budget, BFF
read gate, or generator-level table-function denylist. The connector still enforces its own SQL/SSRF
checks. These recorded limits are not intentional requirements to keep weaker controls; broadening
the graph scope requires addressing them rather than borrowing §B's assurances.

### D. Explore user-requested draft

`POST /api/datasources/generate` and `web/lib/datasource-querygen.ts` are authenticated, user-initiated,
and have no feature flag. The route **never executes or dry-runs**, and does not cache generated queries.
Schema caching is separate. The user reviews a draft before any separately authorized connector execution.
Allow at most two model calls per request (one correction); the route has no separate rate limit.

- **PromQL vocabulary is advisory.** Compare metric tokens with the full cached vocabulary. A remaining
  mismatch returns a warned draft, not rejection. With stale/truncated evidence, skip corrective retry
  unless every unknown recording-rule token has a provably present raw metric core. Keep the uncertainty
  warning even after a clean correction; raw-core existence does not prove the recording rule absent.
  Schemaless generation remains supported. Constant expressions and name selectors can evade this
  heuristic; do not import the worker's stronger relevance contract.
- **TraceQL validation is hard.** Use the pinned parser, observed attribute names/types, and supported
  affirmative HTTP-status templates. Correct at most once; invalid results return 502. Insufficient
  schema/HTTP evidence returns refresh/manual-query guidance without speculative correction. Intrinsic
  filters need not have custom-attribute evidence. The parser is not proof of server/version acceptance
  or general-language semantic correctness.
- **Tempo metadata:** send scoped names, observed types, and server version alongside the user's request;
  never collected raw tag values. Discovery uses bounded recent samples with separate name/type
  truncation signals. Confirmed-empty and background-refresh behavior is intentionally short-lived;
  exact limits live in the collector/cache code and Tempo runbook.
- **Schema-cache overflow:** bound the stored payload, mark trimmed/truncated vocabularies, preserve
  individually probed-name semantics, and cool down background recollection. An incomplete cache
  cannot prove that an unobserved identifier does not exist.
  Every writer must preserve this contract: `web/lib/datasource-schema.ts` uses
  `upsertSchema` / `trimSchemaForCache` / `isLegacyCapSnapshot`; worker `db.py` mirrors it in
  `_trim_schema_for_cache` / `upsert_datasource_schema`.
- **SQL drafts:** keep the existing first-verb read-only check; actual execution remains subject to
  the connector's guards. Draft validation is not execution authorization.

## Consequences

Fallback queries extend discoverability.

### Negative

Costs, heuristic errors, and sample-dependent false positives remain. Worker-generated chips
cannot drive automated findings/alerts. Graph generation has a
narrower scope and fewer controls than signals. Explore drafts intentionally permit advisory PromQL
warnings while rejecting invalid TraceQL. None of these paths authorizes mutation or arbitrary AWS calls.

## Six Pillars

Security: path-specific validation, connector boundaries, and limited metadata disclosure.
Reliability: explicit transient/empty states and bounded retries. Cost/Performance: separate budgets,
schema-version caching for worker artifacts, and per-request limits for drafts. Operational Excellence:
honest provenance and user-visible uncertainty.

## Evidence

`scripts/v2/workers/graph_querygen.py`, `scripts/v2/workers/diagnosis/signal_catalog_gen.py`,
`scripts/v2/workers/datasource_index.py`, `web/lib/{datasource-querygen,diag-signals}.ts`,
`web/app/api/datasources/generate/route.ts`, `agent/lambda/datasource_http.py`, and
[Tempo operating procedure](../runbooks/tempo-query-generation.md).
