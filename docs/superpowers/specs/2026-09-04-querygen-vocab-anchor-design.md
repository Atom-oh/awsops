# NL→PromQL vocabulary anchoring — the '메모리 사용률' chip generates unusable queries

**Status:** Batch 47, 2026-09-04. Owner bug report: the Explore NL chip "메모리 사용률이 높은
인스턴스" on a Prometheus datasource generated
`(1 - :node_memory_MemAvailable_bytes:sum / node_memory_MemTotal_bytes) * 100` — a
recording-rule name absent from the target mixed with a raw per-instance metric: it parses,
returns empty, and reads as "쿼리가 안 맞음". Branch `feat/batch47`.
**WA pillar:** Operational Excellence.

## Root cause

`generateQuery` (web/lib/datasource-querygen.ts) TOLD the model "use only names in the
schema" but verified nothing — the diag-signal generation path gained exactly this gate
(`_mentions_schema_vocabulary`, signal_catalog_gen.py) after the same failure class, and the
Explore path never did.

## Decisions

- **PromQL vocabulary anchoring** (`unknownPromqlNames`, pure + tested): strip strings,
  label-matcher bodies `{…}`, grouping/matching label lists (`by/without/on/ignoring/
  group_left/group_right (…)` — label names are not metrics; caught by our own test), and
  range/offset durations; the remaining bare identifiers minus a PromQL builtin allowlist must
  each appear in the schema block AS A WHOLE TOKEN (`:`/`_` are name chars, `.` a boundary).
  Empty vocabulary → no check, justified on THIS route's own terms (round-1 correction: the
  earlier draft claimed this mirrors the Python gate — INVERTED; the worker gate REJECTS on
  empty vocabulary because without an anchor it cannot establish relevance, while this route
  explicitly supports schema-less generation per resolveSchemaBlock). A connector-truncated
  list (>499 names) also skips the gate — anchoring to a knowably partial vocabulary would
  reject real metrics (the reported metric itself sits past the 80-name RENDER cap, which is
  why the anchor is the FULL cached list, never the rendered block).
- **One corrective retry, then an honest error**: unknown names trigger a single retry with
  the violations named in the user turn; a second failure throws with the names — the route
  502s and the UI shows why, instead of handing the user a query that can never match. The
  route's "never executes" contract holds (no dry run — anchoring is the strongest available
  static check; the diag-signal path's dry run stays a worker-side capability).
- **Prompt hardening (PromQL only)**: prefer raw metrics over recording-rule (`:`) names
  unless the schema lists the rule; arithmetic between two vectors must aggregate both sides
  identically (the exact label-mismatch the reported query had).
- Scope: prometheus/mimir (lang === 'PromQL'). SQL keeps its existing read-only gates;
  LogQL/TraceQL selector grammars don't tokenize into metric names the same way — recorded as
  a follow-up if the same complaint appears there.

## Testing
- unknownPromqlNames: the reported query flags exactly the rule name; schema-only queries
  pass; labels in {} / grouping clauses / strings / durations never count; whole-token
  anchoring; empty schema no-op.
- generateQuery: retry fires once with names in the feedback; corrected retry returned;
  in-vocabulary first answer = one model call; persistent violation throws naming the tokens.
- Full `npm test` + `tsc` non-test + build + `pytest scripts/v2/{workers,steampipe}`;
  CHANGELOG EN/KO.

## Round-1 corrections (review-driven)

- **Tokenizer false positives eliminated (the gate MAJOR)** — `offset 5m` leaked an `m` token,
  `> 1e9` leaked `e9`, `@ start()/end()` flagged the anchors, and `#` comments weren't
  stripped (all three L2 models converged). Number/duration literals and comments are now
  stripped before tokenizing; `start`/`end` join the builtins; builtin matching is
  case-SENSITIVE (PromQL is — `Rate(...)` must flag, not silently pass); an unbalanced `{`
  from a truncated completion throws instead of defeating the brace strip.
- **The anchor is the FULL cached metric list, not the rendered block (the gate MAJORs ×2)** —
  block-text matching both admitted label names/prose as "metrics" (false negatives) and,
  worse, rejected real metrics past the ~80-name render cap — regressing the exact reported
  chip on a kube-prometheus target where zero Korean NL terms match and the block holds the
  alphabetical head (`ALERTS`, …). `schemaMetricNames(schema)` extracts the whole cached list;
  membership is exact Set lookup; a connector-truncated list (>499) skips the gate.
- **ADR-018 amended + BASELINE registered (the gate MAJOR)** — this live path was a third,
  unrecorded LLM query-generation path; a dated ADR-018 Status amendment and a BASELINE
  register row now record its distinct contract (live/no-flag/no-dry-run/≤2 Haiku calls), and
  the spec's inverted claim about the Python gate's empty-vocabulary rule is corrected above.
- Minors closed: the corrective retry includes the model's PREVIOUS answer (it cannot rewrite
  what it cannot see); CHANGELOG entry moved under Fixed (it repairs a reported defect).
- Recorded (accepted): `{__name__="…"}` selectors bypass the gate (the brace strip removes
  them; the prompt steers away from that form); constant expressions (`vector(1)`) pass —
  the worker gate pairs vocabulary with `_is_constant_expr`, a parity follow-up; worst-case
  Bedrock cost per request doubles on an authed route (bounded at 2 calls).

## Round-2 corrections (review-driven)

- **The gate is ADVISORY, never a 502 (resolves three gate MAJORs at the root)** — a static
  PromQL tokenizer can never be exhaustively right (round 2 found subquery `[30m:1m]` residue,
  compound `1h30m` durations, hex, `#`-in-label-value corruption), the connector caps the
  vocabulary at 500 names (so the hard gate silently skipped the exact kube-prometheus class
  the bug report came from), and the 6h-stale cache would hard-reject metrics newer than it.
  A violation surviving the one corrective retry now returns the DRAFT with a `warning`
  naming the tokens (softened wording when the cache is truncated — the connector's own
  `truncated` flag, never a length inference — or stale); the UI shows the warning beside the
  filled query box. The runtime authority stays the connector.
- Tokenizer holes closed: strings stripped BEFORE comments; bracket strip covers subqueries
  (`[1h30m:5m]`, `[1h:]`); compound durations and hex literals stripped; leftover pure-`:`
  tokens and case-insensitive `inf`/`nan` filtered; `first_over_time`/`ts_of_*` join the
  builtins; the retry echoes the previous answer tag-wrapped and suggests near-miss schema
  names (the reported case maps `:node_memory_MemAvailable_bytes:sum` →
  `node_memory_MemAvailable_bytes`).
- **ADR-018/BASELINE reconciled (the gate MAJOR)** — ADR-018 gains a §D for this path (LIVE·
  no-flag·no-dry-run·advisory·≤2 calls), the Status headline/§A scope/§6 Cost·Sustainability
  no longer read as universal claims, the accepted residuals moved into ADR-018's Negative
  section (durable record, not just this working doc), and BASELINE's §2 row + §3 index row
  match.

## Round-3 corrections (review-driven)

- **No hard failure path is left behind the advisory contract (3 gate MAJORs)** — the
  brace-balance check now runs on the STRING-STRIPPED text (`up{payload="{"}` is balanced
  PromQL); an incomplete vocabulary (connector `truncated` flag / stale cache) SKIPS the
  corrective retry — on a real kube-prometheus target the "correction" steered the model away
  from a real metric past the alphabetical 500-name cap toward head near-misses and returned
  that wrong answer CLEAN — and returns the first draft with the soft warning instead; any
  retry failure (Bedrock error, prose, unbalanced) falls back to the valid first draft +
  warning, never a 502.
- **ADR-018 is internally consistent (2 gate MAJORs)** — the Status paragraph's leftover
  round-1 sentence ("truncation skips the gate", the `>499` figure) now states the advisory
  truth; Context lists three paths (the §D bullet added); the bolded Decision scopes the
  ready-0/flag/dry-run condition to §B·§C with an explicit §D carve-out.

## Owner re-test follow-up (batch 48) — "아직 개선 안된거 같아"

Re-tested on /integrations/datasources/472 after #296 deployed: the chip still produced the
recording-rule query. Two stacked root causes the advisory gate could not touch:
1. **The prompt never contained the right metrics.** `prioritizeSchemaForQuery` tokenized NL
   with `[^a-z0-9_]+` — a KOREAN request yields ZERO terms, so the alphabetical head of the
   metric list filled the ~80-name prompt block and the model answered from world knowledge.
   Fix: `nlSearchTerms` expands a curated Korean ops vocabulary (`KO_METRIC_TERMS`: 메모리→
   memory/mem, 사용률→usage/utilization/used, 인스턴스→instance/node, …) into the substring
   terms the ranking already uses; the prompt also forbids ':'-style rule names outright.
2. **The cache itself lacked `node_*`.** The connectors capped the schema at the first 500
   alphabetical names; kube-prometheus stacks have thousands, so `node_memory_*` was absent
   from BOTH the prompt and the anchor — and the round-3 rule (no retry on a truncated cache)
   then left the wrong draft untouched. Fixes: `SCHEMA_METRIC_CAP = 3000` in prometheus/mimir
   connectors (≈120KB JSON, inside the 256KB cache row); the generate route background-refreshes a
   cache that is truncated at exactly 500 names (a PromQL snapshot from the old cap — see Round-2); and a truncated cache no
   longer suppresses the retry when the fix is PROVABLE — an unknown rule name whose raw core is a
   cached metric (`confidentNearMisses`) is corrected with the suggestion regardless of truncation.
Deploy: agent connector zips (terraform apply) + web.

### Round-2 corrections (review-driven)
- **Refresh trigger narrowed + cooldown.** `truncated && names.length <= 500` also matched ClickHouse
  trims, failed metric fetches (0 names) and label-only truncation — none of which converge, so every
  request fired a fresh introspect. Now `isLegacyCapSnapshot`: PromQL kind AND `truncated` AND EXACTLY
  500 names; `refreshInBackground` has a 10-minute per-instance cooldown regardless of trigger.
  Route tests cover the positive case, the three non-firing cases and the cooldown.
- **Size fallback for metric schemas.** `trimSchemaForCache` only trimmed `tables`; at the 6× cap a
  long-name environment could exceed the 256KB row and end up with NO cache row. Metric branch: labels
  → 100, metrics halved until the JSON fits, `truncated: true`. `MAX_SCHEMA_BYTES` exported.
- **Retry gate tightened.** One provable near-miss no longer unlocks the retry for the whole unknown
  set — EVERY unknown token's rule-core must be a cached metric; otherwise no retry (the retry prompt
  condemns the whole set, steering the model away from a possibly-real metric past the cap). On an
  incomplete vocabulary the hedged warning is kept on every branch, including a token-clean rewrite.
  `nearMissCandidates` seeds with `confidentNearMisses` (cap can't crowd out the provable fix) and
  reuses `ruleCore`; suggested names are charset-filtered before entering the prompt.
- **Korean expansions.** Scoring is per concept (memory+mem count once); expansions shorter than 3
  chars ('up', 'fs') match only whole `_`/`:` segments so 'up' never hits 'group'/'setup'.
- **ADR-018 amended** (Status + §D + §Negative cap-agnostic) to record the provable-correction
  exception, the size fallback and the legacy-cap refresh; BASELINE row unchanged (still accurate).

### Round-3 corrections (review-driven)
- **Bounded-store fallback moved into the shared writers.** Only the generate route trimmed; the
  connect-time warm (`/api/datasources/manage`), the admin manual refresh (`/api/integrations/schema`)
  and the worker write-back (`scripts/v2/workers/db.py`) still hard-failed on a >256KB schema. Now
  `upsertSchema` (web) and `upsert_datasource_schema` (worker, mirrored `_trim_schema_for_cache`)
  trim internally and throw only for untrimmable shapes; the route's second-write fallback is gone.
- **Interleaved trim.** The metric trim keeps every k-th name (k doubling until it fits) instead of
  the alphabetical prefix, so the late `node_*`/`kube_*` families survive.
- `ruleCore` documents the presence≠absence asymmetry; BASELINE §2 row names the provable-correction
  carve-out; the batch-48 narrative now says "exactly 500".
