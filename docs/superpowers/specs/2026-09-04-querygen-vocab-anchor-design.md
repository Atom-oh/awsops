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
  Empty schema block → no check (the model was told there is no schema; anchoring to nothing
  is the Python gate's own rule).
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
