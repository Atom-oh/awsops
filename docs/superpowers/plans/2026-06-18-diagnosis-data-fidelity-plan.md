# Plan — AI Diagnosis data fidelity (TDD)

> Spec: `docs/superpowers/specs/2026-06-18-diagnosis-data-fidelity-design.md`.
> Branch `fix/v2-diagnosis-data` (worktree, base = origin/feat/v2-architecture-design).
> Read-only worker change; deploy via `make workers` after merge (no terraform/IAM change).
> Collectors keep their **never-raise / degrade-only** contract. Tests use a fake `conn`
> (the worker uses pg8000 `conn.run(sql)` → list of row tuples) — no live AWS/DB.

## Allowed file scope
- `scripts/v2/workers/diagnosis/sources.py`
- `scripts/v2/workers/diagnosis/test_sources.py`
- `scripts/v2/workers/diagnosis/report.py`
- `scripts/v2/workers/diagnosis/test_report.py`

## Out of scope
New collectors / AWS APIs / IAM; LLM prompt rewrites; section/tier changes; web; terraform.

---

### Task 1: fix `collect_cw_metrics` instance lookup (resource_type + account scope)
- Modify: `scripts/v2/workers/diagnosis/sources.py`
- Create: `scripts/v2/workers/diagnosis/test_sources.py`
- [ ] Failing test: a fake conn whose `inventory_resources` has `resource_type='ec2'` rows returns
      those instance ids (the current `('ec2_instance','aws_ec2_instance','instance')` query finds 0).
      Assert the SQL filters `resource_type` to `'ec2'` and `account_id = 'self'`; with ids present and
      `_cw_client` stubbed, `get_metric_data` is called for them; with no ec2 rows, returns the graceful
      empty `{"by_instance":{}, "avg_cpu":None}` (degrade-only preserved).
- [ ] Implement: change the instance-id query to `WHERE resource_type = 'ec2' AND account_id = 'self'`.
      Leave the CloudWatch call + degrade path unchanged.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/test_sources.py -q`.
- [ ] Commit: `fix(diagnosis): collect_cw_metrics queries resource_type 'ec2' (was never-matching 'ec2_instance')`.

### Task 2: `collect_inventory` returns bounded resource DETAIL, not just counts (keystone)
- Modify: `scripts/v2/workers/diagnosis/sources.py`
- Test: `scripts/v2/workers/diagnosis/test_sources.py`
- [ ] Failing tests: with a fake conn returning typed rows (incl. a `data` JSONB per resource — test
      both dict and JSON-string forms, since pg8000 may hand back text): (a) result has
      `resources[<type>]` with `{resource_id, region, data}` entries, not only `by_type`; (b) the SQL
      scopes `account_id = 'self'`; (c) per-type cap `DIAG_INV_PER_TYPE` honored; (d) the global byte
      cap `DIAG_INV_MAX_BYTES` truncates + sets `truncated: true` for an oversized account; (e) on a
      query error it still degrades (never raises) and keeps `by_type`/`resources` keys present.
- [ ] Implement: keep the `by_type` count query (add `WHERE account_id='self'`). Add a detail pass:
      for each type in `by_type`, `SELECT resource_id, region, data FROM inventory_resources WHERE
      account_id='self' AND resource_type=$1 LIMIT <DIAG_INV_PER_TYPE>` (default 15); parse `data` with
      `json.loads` if it's a str; accumulate into `resources[type]` until the serialized size would
      exceed `DIAG_INV_MAX_BYTES` (default 24000), then stop + set `truncated`. Return
      `{by_type, resources, truncated}`. Pre-LLM `_redact` (report.py) still handles PII — unchanged.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/test_sources.py -q`.
- [ ] Commit: `feat(diagnosis): collect_inventory feeds real resource detail (region+data, bounded) not just counts`.

### Task 3: render a data-coverage note so thin reports are self-explaining
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- [ ] Failing test: `build_markdown` (or a small `_coverage_note(collected)` helper) given a
      `collected` map where one collector is degraded and another empty renders a "데이터 커버리지"
      section listing each collector as `ok | degraded(<note>) | empty`. A fully-ok set still renders
      the note (all ok). The note appears in the final markdown.
- [ ] Implement: add `_coverage_note(collected)` returning a compact markdown block; `generate`
      passes `collected` through and `build_markdown` appends the note at the end (after sections).
      Reuse the existing `degraded`/notes data already computed in `generate`.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/test_report.py -q`.
- [ ] Commit: `feat(diagnosis): append a data-coverage note (which collectors had data) to the report`.

### Task 4: full diagnosis test sweep
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/ -q` — all green (existing + new).
- [ ] (no commit — verification only)
