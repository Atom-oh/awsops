"""datasource_index worker job — (re)build pre-computed diagnostic signals for ONE datasource.

Reads the instance's CACHED introspected schema (datasource_schemas — written by the BFF/connector
refresh; this job does NOT re-implement introspection), hashes the metric set + CATALOG_VERSION,
and rebuilds datasource_diag_signals ONLY when that hash changed (version upgrade adds/removes/renames
metrics). Idempotent, bounded, never raises — a bad instance never sinks the dispatcher.

Read-only: derives queries from a cached schema; no AWS mutation, no egress here (the cache read is
local Aurora). Prometheus/Mimir only in v1 (other kinds keep the diagnosis generic planner).
"""
import hashlib
import json
import logging
import os

try:  # fargate/tests: package path; lambda worker zip flattens it to signal_catalog.py
    from diagnosis import signal_catalog as _cat
except ImportError:  # noqa: F401
    import signal_catalog as _cat  # flattened in the worker_src lambda bundle

_KINDS = ("prometheus", "mimir")


def _read_cached_schema(conn, integration_id):
    """(kind, schema_dict) from the most-recent cached row, preferring this account then 'self'.
    Returns (None, None) when no cache row exists (connector never succeeded / not refreshed yet)."""
    acct = os.environ.get("HOST_ACCOUNT_ID") or os.environ.get("AWS_ACCOUNT_ID") or "self"
    rows = conn.run(
        "SELECT kind, schema FROM datasource_schemas WHERE account_id IN (:acct, 'self') AND integration_id=:iid "
        "ORDER BY (account_id = :acct) DESC, fetched_at DESC LIMIT 1",
        acct=acct, iid=integration_id)
    if not rows:
        return None, None
    kind, schema = rows[0][0], rows[0][1]
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except (ValueError, TypeError):
            schema = None
    return kind, (schema if isinstance(schema, dict) else None)


def _schema_version(schema):
    """Stable cross-process hash of the metric-name set + CATALOG_VERSION (NOT salted hash())."""
    metrics = sorted({m for m in (schema.get("metrics") or []) if isinstance(m, str)})
    basis = json.dumps(metrics, separators=(",", ":")) + "|" + _cat.CATALOG_VERSION
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def run(payload, conn):
    """Rebuild signals for payload['integration_id'] if its schema hash changed. Never raises."""
    import db as wdb
    iid = payload.get("integration_id")
    try:
        kind, schema = _read_cached_schema(conn, iid)
        if kind is None and schema is None:
            # no cache row at all → connector never succeeded / not refreshed → preserve last-good, skip
            return {"integration_id": iid, "no_schema": True}
        if kind not in _KINDS:
            # non-prom/mimir: out of v1 scope (diagnosis keeps the generic planner for these)
            return {"integration_id": iid, "skipped_kind": kind}
        if schema is None:
            # row exists but schema unparseable → can't build; preserve last-good, skip destructively
            return {"integration_id": iid, "no_schema": True}
        version = _schema_version(schema)
        if wdb.read_signal_schema_version(conn, iid) == version:
            return {"integration_id": iid, "skipped": True, "schema_version": version}
        rows = _cat.build_signals(kind, schema)          # present-but-empty metrics → all unavailable
        wdb.upsert_diag_signals(conn, iid, rows, version)
        wdb.sweep_diag_signals(conn, iid, [r["signal_key"] for r in rows])
        return {"integration_id": iid, "built": len(rows),
                "ready": sum(1 for r in rows if r["status"] == "ready"), "schema_version": version}
    except Exception as e:  # noqa: BLE001 — never sink the dispatcher; surface on the job result
        logging.warning("[datasource_index] integration %s failed: %s", iid, e)
        return {"integration_id": iid, "error": str(e)[:300]}
