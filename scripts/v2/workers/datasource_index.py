"""datasource_index worker job — (re)build pre-computed diagnostic signals AND pre-built
topology-graph queries for ONE datasource.

Reads the instance's CACHED introspected schema (datasource_schemas — normally written by the BFF's
warm/refresh path), attempts a LIVE re-introspection via the connector's `{kind}_schema` tool (drift
detection — docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md), and rebuilds two
independent tables, each gated on its OWN schema-version hash so a rebuild only happens when something
actually changed:
  - datasource_diag_signals (diagnosis/signal_catalog.py) — prometheus/mimir/loki/tempo deterministic,
    clickhouse via the flag-gated LLM fallback only; jaeger/dynatrace/datadog are NOT wired
    (DIAG_SIGNAL_KINDS, the daily dispatcher's _LIST_SQL and ds_connector_arns are all 5-kind).
    Per-kind catalog + LLM hybrid fallback when a kind's catalog has zero ready matches.
  - datasource_graph_queries (graph_catalog.py) — ALL 5 connector kinds (capability-driven: only
    clickhouse/tempo get span queries, prometheus/mimir get them only with a service-graph metric,
    loki is structurally unavailable — see graph_catalog.py).
Idempotent, bounded, never raises — a bad instance never sinks the dispatcher. Live re-introspection
failing (endpoint down, timeout, bad response) falls back to the cached schema; it never blocks the
rebuild, it only means drift can't be detected on this run.
"""
import hashlib
import json
import logging
import os
import re

import boto3

try:  # fargate/tests: package path; lambda worker zip flattens it to signal_catalog.py
    from diagnosis import signal_catalog as _cat
except ImportError:  # noqa: F401
    import signal_catalog as _cat  # flattened in the worker_src lambda bundle

import graph_catalog as _graph_cat  # always flat next to this file — never under a package
import graph_querygen as _querygen  # hybrid LLM fallback (v1 scope: clickhouse trace_spans only)
from datetime import datetime, timezone

try:  # fargate/tests: package path; lambda worker zip flattens it to signal_catalog_gen.py
    from diagnosis import signal_catalog_gen as _signal_gen
except ImportError:  # noqa: F401
    import signal_catalog_gen as _signal_gen  # flattened in the worker_src lambda bundle


def _read_cached_schema(conn, integration_id):
    """(kind, schema_dict) from the most-recent cached row, preferring this account then 'self'.
    Returns (None, None) when no cache row exists (connector never succeeded / not refreshed yet)."""
    acct = os.environ.get("HOST_ACCOUNT_ID") or os.environ.get("AWS_ACCOUNT_ID") or "self"
    rows = conn.run(
        "SELECT kind, schema FROM datasource_schemas WHERE account_id IN (:acct, 'self') AND integration_id=:iid "
        "ORDER BY (account_id = :acct) DESC, fetched_at DESC LIMIT 1",
        acct=acct, iid=integration_id)
    if not rows:
        # Account-scope miss → fall back to integration_id alone (mirrors sources.py:_ds_schema). This
        # is safe ONLY because `integrations` is single-account (one integration_id = one instance), and
        # it prevents a BFF/worker HOST_ACCOUNT_ID mismatch from blanking the build (signals never built).
        rows = conn.run(
            "SELECT kind, schema FROM datasource_schemas WHERE integration_id=:iid "
            "ORDER BY fetched_at DESC LIMIT 1",
            iid=integration_id)
        if rows:
            logging.warning("[datasource_index] integration %s schema not under (%r,'self') — using "
                            "integration_id fallback (BFF/worker account-key mismatch)", integration_id, acct)
    if not rows:
        return None, None
    kind, schema = rows[0][0], rows[0][1]
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except (ValueError, TypeError):
            schema = None
    return kind, (schema if isinstance(schema, dict) else None)


def _lambda_invoke(kind, tool, arguments=None):
    """Credential-blind connector invoke (same shape as diagnosis/sources.py:_invoke_connector),
    duplicated locally because this is a LAMBDA-runtime handler whose zip only bundles this file +
    signal_catalog.py + graph_catalog.py + graph_querygen.py (see workers.tf's archive_file), not the
    full diagnosis package. Raises on failure (FunctionError, non-2xx statusCode) — callers decide
    how to handle it; never returns an error envelope as if it were a schema."""
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    project = os.environ.get("PROJECT", "awsops-v2")
    client = boto3.client("lambda", region_name=region)
    req = json.dumps({"tool_name": tool, "arguments": arguments or {}}).encode("utf-8")
    resp = client.invoke(FunctionName=f"{project}-agent-{kind}-mcp", Payload=req)
    if resp.get("FunctionError"):
        raise RuntimeError(f"{kind}-mcp {tool} invoke FunctionError: {resp['FunctionError']}")
    raw = resp["Payload"].read()
    out = json.loads(raw) if raw else {}
    status = out.get("statusCode")
    if isinstance(status, int) and status >= 400:
        raise RuntimeError(f"{kind}-mcp {tool} returned statusCode {status}")
    body = out.get("body")
    if isinstance(body, str):
        body = json.loads(body)
    return body


# Minimal expected-shape key per connector kind (mirrors the spec's cached-schema shapes) — a
# connector error envelope (e.g. {"error": "..."}) has none of these, so it can never be mistaken
# for a real schema even if `_lambda_invoke` ever let one through undetected.
_SCHEMA_SHAPE_KEY = {
    "clickhouse": "tables", "tempo": "tags", "prometheus": "metrics",
    "mimir": "metrics", "loki": "labels",
}


def _looks_like_schema(kind, body):
    if not isinstance(body, dict):
        return False
    key = _SCHEMA_SHAPE_KEY.get(kind)
    return isinstance(body.get(key), list) if key else True


def _reintrospect(kind, integration_id):
    """Live schema fetch via the `{kind}_schema` tool. Returns the schema dict on success, or None on
    ANY failure OR a response that doesn't look like a real schema (never raises) — the caller falls
    back to the cached schema."""
    try:
        body = _lambda_invoke(kind, f"{kind}_schema", {"instance_id": integration_id})
        return body if _looks_like_schema(kind, body) else None
    except Exception:  # noqa: BLE001 — a flaky/down connector must never block the daily rebuild
        return None


def _schema_version(schema):
    """Stable cross-process hash of the FULL schema (all kinds' catalog entries key off different
    parts of it — labels/tables/tags, not just metric names) + signal_catalog.CATALOG_VERSION + the
    DIAG_SIGNAL_QUERYGEN_ENABLED flag's on/off state. Mirrors _graph_schema_version's reasoning: the flag is
    mixed in so flipping it — with the schema itself unchanged — still changes
    the version and forces a rebuild; otherwise an instance first indexed while the flag was off
    (catalog matched zero ready rows, LLM fallback skipped) would stay permanently stuck with zero
    ready signals even after the flag turns on, since nothing about the schema itself would ever
    drift again. NOT salted hash()."""
    # EXACTLY ONE flag: DIAG_SIGNAL_QUERYGEN_ENABLED gates THIS pipeline's fallback. Mixing only the graph
    # flag meant turning the new one on left every already-indexed instance's version unchanged → skip → the
    # fallback never ran for the instances it was added for (review). Mixing BOTH then rebuilt signals
    # whenever a graph-only feature was toggled (review MINOR) — dropping the graph flag is safe because
    # CATALOG_VERSION v4 already invalidates every stored hash once.
    flag = "1" if os.environ.get("DIAG_SIGNAL_QUERYGEN_ENABLED") == "true" else "0"
    basis = (json.dumps(schema, sort_keys=True, separators=(",", ":")) + "|" + _cat.CATALOG_VERSION
             + "|dsquerygen=" + flag)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def _graph_schema_version(schema):
    """Stable cross-process hash of the FULL schema (graph queries key off tables too, not just
    metric names — e.g. clickhouse) + graph_catalog.CATALOG_VERSION + the querygen flag's on/off
    state. The flag is mixed in so flipping GRAPH_QUERYGEN_ENABLED — with the schema itself
    unchanged — still changes the version and forces a rebuild; otherwise a schema cached while the
    flag was off (catalog 'unavailable', hybrid fallback skipped) stays permanently skipped after the
    flag turns on, since nothing about the schema itself would ever drift again."""
    flag = "1" if os.environ.get("GRAPH_QUERYGEN_ENABLED") == "true" else "0"
    basis = (json.dumps(schema, sort_keys=True, separators=(",", ":")) + "|" + _graph_cat.CATALOG_VERSION
             + "|querygen=" + flag)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


_MAX_GENERATION_ATTEMPTS = 3   # TOTAL tries per schema_version PER ISO WEEK, retries included


def _iso_week():
    return datetime.now(timezone.utc).strftime("%G%V")


# The stored value is `<hash>` or `<hash>:<state><attempts>w<isoweek>[s<streak>]`, state ∈ {pend, done}.
# `attempts` = generations spent this week; `streak` = consecutive weeks whose budget was spent without
# producing anything. Four review rounds shaped this grammar, each closing the previous one's hole:
#   * the budget must survive schema churn — the marker is read regardless of which hash prefixes it, or a
#     Prometheus whose metric set moves on every deploy gets a fresh budget daily (MAJOR-3);
#   * a spent budget must not freeze the instance forever — the week rolls and the retry comes back (L4-M3);
#   * a READY/conclusive outcome must not erase the week's usage, or an instance whose catalog match flaps
#     buys 3 more tries per flap (stop-gate);
#   * but "the week rolls" cannot mean retrying forever either: with an unchanged schema that keeps failing,
#     weekly retries are unbounded Bedrock spend (MAJOR-1/-7). After _MAX_SPENT_WEEKS consecutive spent
#     weeks the instance stops until the SCHEMA changes — which is the only new information there is.
_MARKER_RE = re.compile(r":(pend|done)(\d+)w(\d{5,8})(?:s(\d+))?$")
_PEND, _DONE = "pend", "done"
_MAX_SPENT_WEEKS = 3


def _marker_state(existing, version):
    """(base_hash, attempts_used_this_week, done_for_this_week, spent_week_streak).

    Legacy encodings: a plain hash is conclusive and keeps skipping (CATALOG_VERSION v4 retired its
    ambiguous "gave up" meaning), while this branch's earlier `:retryN`, `:retryNw<week>` and `:spent<week>`
    forms read as a fresh, NOT-settled budget — retrying is the safe direction for an unrecognised marker.

    `version` is needed for exactly ONE decision: whether to un-park a streak-capped instance. Everywhere
    else, attempts/streak are read regardless of which hash prefixes the marker — that's what makes the
    budget survive ordinary schema churn WITHIN a week (a Prometheus whose metric set shifts on every run
    must not get a fresh 3-try budget every run just because the hash moved — review MAJOR-3, three rounds
    ago). But "stops until the SCHEMA changes" (the streak-cap comment below) is a promise this function has
    to keep too: forcing attempts=MAX unconditionally in that branch meant a genuinely NEW schema, arriving
    in a new week after the streak cap, stayed parked forever — the comment's own recovery path didn't exist
    (review MAJOR, this round). So only the streak-capped branch compares the hash; ordinary within-budget
    retries are untouched.
    """
    m = _MARKER_RE.search(existing or "")
    if not m:
        base, _, marker = (existing or "").partition(":")
        return base, 0, bool(base) and not marker, 0
    state, attempts, week, streak = m.group(1), int(m.group(2)), m.group(3), int(m.group(4) or 0)
    if week == _iso_week():
        return existing[:m.start()], attempts, state == _DONE, streak
    base = existing[:m.start()]
    # A new week. The budget returns, but only while the streak of spent weeks is under the cap; at the cap
    # the instance stays settled UNLESS its schema has genuinely changed, which is the only new information
    # that justifies spending another 3-week budget on it.
    if streak >= _MAX_SPENT_WEEKS:
        if base != version:
            return base, 0, False, 0
        return base, _MAX_GENERATION_ATTEMPTS, True, streak
    return base, 0, False, streak


def _marker(version, attempts, done, streak):
    tail = f"s{streak}" if streak else ""
    return f"{version}:{_DONE if done else _PEND}{attempts}w{_iso_week()}{tail}"


def _keep_last_good_generated(conn, wdb, iid, kind, schema, rows):
    """Carry a previously VERIFIED generated row through a failed re-generation.

    The rebuild is mark-and-sweep: sweep_diag_signals deletes every key not written this time, so a chip
    that generated fine last week was destroyed the moment the weekly retry hit a connector blip — a
    transient outage permanently removing verified content (review MAJOR-2). It is only carried over if its
    expression STILL matches the current schema's vocabulary and still measures something, which is the same
    pure check the generator gates on; a stored query whose table has since disappeared is not resurrected.
    """
    try:
        existing = [r for r in wdb.list_diag_signals(conn, iid)
                    if (r.get("meta") or {}).get("provenance") == "generated" and r.get("status") == "ready"]
    except Exception:                      # noqa: BLE001 — read failure must not break the rebuild
        return rows
    kept = []
    for r in existing:
        exprs = [q.get("expr") for q in ((r.get("query") or {}).get("queries") or [])]
        if not exprs or not all(exprs):
            continue
        if all(_signal_gen.still_relevant(kind, schema, e) for e in exprs):
            kept.append({"signal_key": r["signal_key"], "title": r.get("title"), "status": "ready",
                         "query": r["query"], "missing_metrics": None, "meta": r.get("meta")})
        else:
            logging.info("[datasource_index] integration %s: dropping generated row %s — its expression no "
                         "longer matches the schema", iid, r["signal_key"])
    return list(rows) + kept


def _rebuild_diag_signals(conn, wdb, iid, kind, schema):
    version = _schema_version(schema)
    existing_version = wdb.read_signal_schema_version(conn, iid)
    base, attempts, done, streak = _marker_state(existing_version, version)
    # Skip only when the schema is unchanged AND this week is settled — either the last outcome was
    # conclusive or the budget is spent. A `pend` marker means a retry is owed, so it must NOT skip.
    if base == version and done:
        return {"skipped": True, "schema_version": existing_version}
    rows = _cat.build_signals(kind, schema)  # present-but-empty metrics → all unavailable
    exhausted = attempts >= _MAX_GENERATION_ATTEMPTS
    gen_status = None
    if not any(r["status"] == "ready" for r in rows):
        if not exhausted:
            generated, gen_status = _signal_gen.try_generate_signal_with_status(
                kind, schema, iid,
                lambda args: _lambda_invoke(kind, _cat._KIND_TOOL.get(kind, f"{kind}_query"), args))
            if generated:
                rows = list(rows) + [generated]
        # Carrying the last-known-good chip is PART OF THE FEATURE, so it is gated like the feature: with
        # the flag off, generated content must stop being served, and preserving it there kept an LLM row
        # alive indefinitely after the gate closed (Codex stop-gate). It must also run when the week is
        # parked (`exhausted`, so no generation was attempted at all) — otherwise the park itself swept the
        # chip away, which is the same deletion MAJOR-2 was about.
        if os.environ.get("DIAG_SIGNAL_QUERYGEN_ENABLED") == "true" \
                and not any(r["status"] == "ready" for r in rows):
            rows = _keep_last_good_generated(conn, wdb, iid, kind, schema, rows)
    # WHICH OUTCOMES ARE WORTH REMEMBERING. A build with no ready signal is remembered (plus a sentinel row
    # when there is nothing at all) so the daily job stops rebuilding — but only when the outcome is
    # conclusive, and "conclusive" cost three review rounds to pin down:
    #   * TRANSIENT (Bedrock throttled, connector down — every exception, since the connectors collapse a
    #     503 into the same 400 as a bad query) is not conclusive. Recording it froze a retryable failure
    #     into a permanent skip, and NOT only for an empty build: loki/tempo normally produce `unavailable`
    #     rows, and persisting THOSE settled the week just as effectively.
    #   * REJECTED is not conclusive either. The model is not deterministic and the prompt, catalog and
    #     gates all change, so "the answer failed a gate once" is not a fact about this schema.
    #   * DISABLED is — the flag is part of the hash, so flipping it rebuilds anyway.
    # The rows are written either way (they carry the "metric X missing" text the UI shows); what differs is
    # whether the marker says this week is settled.
    ready_now = any(r["status"] == "ready" for r in rows)
    # REJECTED retries under the weekly budget too — the model is not deterministic and the prompt, catalog
    # and gates all change, so "the answer failed a gate once" is not a fact about this schema. It only
    # differs from TRANSIENT in the log message a caller might want; both are retried the same way.
    retry_needed = gen_status in (_signal_gen.TRANSIENT, _signal_gen.REJECTED) and not ready_now
    if retry_needed and attempts + 1 >= _MAX_GENERATION_ATTEMPTS:
        logging.warning("[datasource_index] integration %s: generation failed on all %s attempts this week; "
                        "parking it until the week rolls over or the schema changes", iid, attempts + 1)
        retry_needed = False
    # Count only the attempts that actually reached the model. DISABLED means the flag is off, so no Bedrock
    # call happened — charging the budget for it meant three rebuilds with the feature OFF exhausted the
    # week, and then turning the flag ON did nothing for up to a week: the flag change rebuilds (it is in
    # the hash) but `attempts` is read whatever hash prefixes it, so the instance was already "exhausted".
    # Enabling a feature must not be pre-empted by the period it spent disabled (Codex stop-gate).
    charged = gen_status is not None and gen_status != _signal_gen.DISABLED
    spent = attempts + (1 if charged else 0)
    # The streak counts WEEKS that ended with the budget spent and nothing to show. It advances once per
    # week (only on the run that exhausts the budget), resets the moment something is ready, and caps the
    # weekly retry at _MAX_SPENT_WEEKS so an unchanged, permanently failing schema stops costing Bedrock.
    if ready_now:
        new_streak = 0
    elif not retry_needed and spent >= _MAX_GENERATION_ATTEMPTS and attempts < _MAX_GENERATION_ATTEMPTS:
        new_streak = streak + 1
    else:
        new_streak = streak
    # A marker (week + attempts + streak) is only worth carrying when something is genuinely UNRESOLVED —
    # an active or exhausted-this-week retry. Everything else (ready now, including a carried-over
    # last-known-good chip; or DISABLED, whose flag state is already in the hash) is fully conclusive and
    # gets the PLAIN version, exactly like the deterministic-catalog path always has. Storing a marker for a
    # ready/settled outcome was the other MAJOR this review round found: it made the daily job re-invoke
    # Bedrock every week for a schema that was already being served successfully — every ISO week the marker
    # ages out of `week == _iso_week()`, `done` reverts to False, and generation ran again on an unchanged
    # schema, which also directly contradicted ADR-018 §A-4/Sustainability ("cached, not regenerated").
    needs_marker = not ready_now and (gen_status in (_signal_gen.TRANSIENT, _signal_gen.REJECTED) or exhausted)
    stored_version = _marker(version, spent, done=not retry_needed, streak=new_streak) if needs_marker \
        else version
    # Atomic upsert+sweep (M3): a partial upsert must not leave some rows on the new schema_version
    # while others stay stale — the next run would read a new-version row, judge "unchanged", and
    # lock in the stale/missing signals. One transaction makes the rebuild all-or-nothing.
    conn.run("BEGIN")
    try:
        written = wdb.upsert_diag_signals(conn, iid, rows, stored_version)
        # Sweep against what was WRITTEN, not against `rows`: an empty build writes a version sentinel
        # (db.SCHEMA_VERSION_SENTINEL_KEY) and sweeping `rows` would delete it right back.
        wdb.sweep_diag_signals(conn, iid, written)
        conn.run("COMMIT")
    except Exception:
        conn.run("ROLLBACK")
        raise
    return {"built": len(rows), "ready": sum(1 for r in rows if r["status"] == "ready"),
            "schema_version": stored_version,
            **({"retry": "generation failed transiently"} if retry_needed else {})}


def _hybrid_fallback(kind, schema, iid, rows):
    """v1 scope: clickhouse trace_spans only. If the catalog couldn't match, ask graph_querygen for a
    generated candidate; a success REPLACES that one row. Never lets a querygen failure/exception
    break the catalog-based rebuild — `rows` (the catalog's own, possibly-unavailable, result) is
    always a safe fallback."""
    if kind != "clickhouse":
        return rows
    idx = next((i for i, r in enumerate(rows) if r.get("query_key") == "trace_spans"), None)
    if idx is None or rows[idx].get("status") != "unavailable":
        return rows
    try:
        generated = _querygen.try_generate_clickhouse_trace_spans(
            schema, iid, lambda args: _lambda_invoke("clickhouse", "clickhouse_query", args))
    except Exception as e:  # noqa: BLE001 — querygen must never break the catalog-based rebuild
        logging.warning("[datasource_index] graph_querygen failed for integration %s: %s", iid, e)
        return rows
    if generated:
        rows = list(rows)
        rows[idx] = generated
    return rows


def _rebuild_graph_queries(conn, wdb, iid, kind, schema):
    version = _graph_schema_version(schema)
    if wdb.read_graph_schema_version(conn, iid) == version:
        return {"graph_skipped": True}
    rows = _graph_cat.build_graph_queries(kind, schema)
    rows = _hybrid_fallback(kind, schema, iid, rows)
    conn.run("BEGIN")
    try:
        wdb.upsert_graph_queries(conn, iid, rows, version)
        wdb.sweep_graph_queries(conn, iid, [r["query_key"] for r in rows])
        conn.run("COMMIT")
    except Exception:
        conn.run("ROLLBACK")
        raise
    return {"graph_built": len(rows), "graph_ready": sum(1 for r in rows if r["status"] == "ready")}


def run(payload, conn):
    """Rebuild diag signals + graph queries for payload['integration_id']. Never raises."""
    import db as wdb
    iid = payload.get("integration_id")
    # Gate: only build when the datasource-diagnosis feature is enabled (same DIAG_DATASOURCES_ENABLED
    # the collector checks; wired to the worker lambda via terraform local.ds_env_map, which also grants
    # the connector-invoke IAM this job's live re-introspection needs). Keeps the always-on enqueue path
    # (BFF add/refresh + REGISTRY + the daily dispatcher) a no-op when datasource_diagnosis_enabled=false.
    if os.environ.get("DIAG_DATASOURCES_ENABLED") != "true":
        return {"integration_id": iid, "disabled": True}
    try:
        cached_kind, schema = _read_cached_schema(conn, iid)
        # kind travels in the payload (the dispatcher already knows it from `integrations`) — falls
        # back to the cache for jobs enqueued before this field existed, or manual/ad-hoc enqueues.
        kind = payload.get("kind") or cached_kind
        if kind is None:
            # no cache row AND no kind to even attempt live introspection with → truly nothing to build
            return {"integration_id": iid, "no_schema": True}

        out = {"integration_id": iid}
        fresh = _reintrospect(kind, iid)
        if fresh is not None:
            if schema is None or json.dumps(fresh, sort_keys=True) != json.dumps(schema, sort_keys=True):
                acct = os.environ.get("HOST_ACCOUNT_ID") or os.environ.get("AWS_ACCOUNT_ID") or "self"
                try:
                    wdb.upsert_datasource_schema(conn, acct, iid, kind, fresh)
                except ValueError:
                    # oversized schema (256KB cap, mirrors the BFF) — still USE it for this run's
                    # rebuild below, just don't persist it; the cache keeps the last-good schema.
                    out["schema_cache_skipped"] = "oversized"
            schema = fresh
        else:
            out["introspect_error"] = "introspect_failed"  # fall back to whatever `schema` already is

        if schema is None:
            out["no_schema"] = True
            return out

        out.update(_rebuild_diag_signals(conn, wdb, iid, kind, schema))
        out.update(_rebuild_graph_queries(conn, wdb, iid, kind, schema))
        return out
    except Exception as e:  # noqa: BLE001 — never sink the dispatcher; surface on the job result
        logging.warning("[datasource_index] integration %s failed: %s", iid, e)
        return {"integration_id": iid, "error": str(e)[:300]}
