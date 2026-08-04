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
    querygen flags' on/off state. Mirrors _graph_schema_version's reasoning: a flag is
    mixed in so flipping it — with the schema itself unchanged — still changes
    the version and forces a rebuild; otherwise an instance first indexed while the flag was off
    (catalog matched zero ready rows, LLM fallback skipped) would stay permanently stuck with zero
    ready signals even after the flag turns on, since nothing about the schema itself would ever
    drift again. NOT salted hash()."""
    # DIAG_SIGNAL_QUERYGEN_ENABLED is the flag that gates THIS pipeline's fallback (graph_querygen has
    # its own), so it is the one that must be mixed in. Mixing only the graph flag meant turning the new
    # one on left every already-indexed instance's version unchanged → skip → the fallback never ran for
    # exactly the instances it was added for (review finding). Both are included: the graph flag stays for
    # continuity with versions written before the split.
    flag = "1" if os.environ.get("DIAG_SIGNAL_QUERYGEN_ENABLED") == "true" else "0"
    gflag = "1" if os.environ.get("GRAPH_QUERYGEN_ENABLED") == "true" else "0"
    basis = (json.dumps(schema, sort_keys=True, separators=(",", ":")) + "|" + _cat.CATALOG_VERSION
             + "|querygen=" + gflag + "|dsquerygen=" + flag)
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


def _retry_state(existing, version):
    """(attempts_used, exhausted_this_week) read back from the stored version marker.

    The budget resets weekly. Spending it used to be PERMANENT — the plain version was stored and the
    schema never changes for a quiet datasource, so an instance that happened to be idle for three runs
    (night, low traffic) stayed chip-less forever (review MAJOR, L4-M3). `:retryN w<week>` counts this
    week's tries; `:spent<week>` means they are gone, and since neither marker equals `version` the
    rebuild still runs each day — it just skips the Bedrock call until the week rolls over.
    """
    if not existing or not existing.startswith(f"{version}:"):
        return 0, False
    marker, week = existing[len(version) + 1:], _iso_week()
    m = re.match(r"retry(\d+)w(\d+)$", marker)
    if m:
        return (int(m.group(1)), False) if m.group(2) == week else (0, False)
    m = re.match(r"spent(\d+)$", marker)
    if m:
        current = m.group(1) == week
        return (_MAX_GENERATION_ATTEMPTS if current else 0), current
    return 0, False


def _rebuild_diag_signals(conn, wdb, iid, kind, schema):
    version = _schema_version(schema)
    existing_version = wdb.read_signal_schema_version(conn, iid)
    if existing_version == version:
        return {"skipped": True, "schema_version": version}
    rows = _cat.build_signals(kind, schema)  # present-but-empty metrics → all unavailable
    attempts, exhausted = _retry_state(existing_version, version)
    gen_status = None
    if not any(r["status"] == "ready" for r in rows) and not exhausted:
        generated, gen_status = _signal_gen.try_generate_signal_with_status(
            kind, schema, iid,
            lambda args: _lambda_invoke(kind, _cat._KIND_TOOL.get(kind, f"{kind}_query"), args))
        if generated:
            rows = list(rows) + [generated]
    # A build with no ready signal is remembered via the recorded schema_version (plus a sentinel row when
    # there is nothing at all) so the daily job stops rebuilding — but ONLY when that outcome is
    # conclusive. A Bedrock throttle or a connector outage returns TRANSIENT, and recording the real
    # version then freezes a retryable failure into a permanent skip: the schema never changes, so the job
    # skips forever and the signal never appears even after the outage ends.
    #
    # Note this is NOT limited to an empty build (review, second pass): loki/tempo normally produce
    # `unavailable` catalog rows, and persisting THOSE under the real version skips the retry just as
    # effectively. So the rows are still written — they carry the "metric X missing" text the UI shows —
    # but under a deliberately mismatching version, which makes the next run rebuild and retry.
    # BOUNDED retry, per week. A transient failure must not record the real version (that skips forever),
    # but it must not retry forever either: the connectors collapse upstream 503s into the same 400 as a bad
    # query, so the cause is unknowable from the response and an unbounded `:retry` meant daily Bedrock calls
    # for a query that may never work. `:retryN` means N generations already ran, so this run is number N+1
    # and _MAX_GENERATION_ATTEMPTS counts GENERATIONS, not extra ones. Spending the budget parks the
    # instance for the rest of the ISO week (see _retry_state), not forever.
    retry_needed = gen_status == _signal_gen.TRANSIENT and not any(r["status"] == "ready" for r in rows)
    if exhausted:
        stored_version = existing_version   # keep this week's `:spent` marker; retry when the week rolls
    elif not retry_needed:
        stored_version = version
    elif attempts + 1 >= _MAX_GENERATION_ATTEMPTS:
        logging.warning("[datasource_index] integration %s: generation failed on all %s attempts this week; "
                        "parking it until the week rolls over or the schema changes", iid, attempts + 1)
        retry_needed = False
        stored_version = f"{version}:spent{_iso_week()}"
    else:
        stored_version = f"{version}:retry{attempts + 1}w{_iso_week()}"
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
