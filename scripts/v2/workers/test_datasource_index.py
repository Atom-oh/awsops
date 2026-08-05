"""Tests for datasource_index.run — schema-cache read → stable hash → rebuild-on-change.

Widened (registry-driven graph sources, 2026-07-08) to also: (a) accept `kind` in the payload (the
dispatcher now looks it up once so the job never has to), (b) attempt a live re-introspection via the
connector's `{kind}_schema` tool and write back to datasource_schemas on drift, falling back to the
cache on any failure, and (c) build pre-computed topology-graph queries (graph_catalog.py) across ALL
5 datasource kinds — independent of the diag-signals build, which now covers every kind too (its own
per-kind catalog + an LLM hybrid fallback when a kind's catalog matches zero ready rows).

A by-pattern FakeConn drives the real db helpers (upsert/read-version/sweep) through run(), so the
test exercises the actual SQL helpers too. No Aurora, no real connector egress: `_reintrospect` is
stubbed to a deterministic no-op (returns None, i.e. "introspection unavailable") by the autouse
fixture UNLESS a test explicitly overrides it — this is what keeps the suite from making real boto3
calls now that live re-introspection exists.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pytest  # noqa: E402
import datasource_index as dsi  # noqa: E402
import db as wdb  # noqa: E402

_REAL_REINTROSPECT = dsi._reintrospect  # saved before the autouse fixture below stubs it out


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setenv("DIAG_DATASOURCES_ENABLED", "true")  # M2: run() is gated on this
    # Default: no live egress in tests — introspection "fails" (returns None), so run() falls back
    # to the cached schema exactly like before this feature existed. Tests of the live path override.
    monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: None)

PROM_METRICS = [
    "container_cpu_cfs_throttled_periods_total", "container_cpu_cfs_periods_total",
    "kube_pod_container_status_last_terminated_reason",
    "node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes",
    "node_filesystem_avail_bytes", "node_filesystem_size_bytes",
    "node_network_receive_packets_total", "node_network_receive_drop_total",
    "container_memory_working_set_bytes", "kube_pod_container_resource_requests",
    "node_cpu_seconds_total", "kube_pod_container_status_restarts_total",
]

OTEL_COLUMNS = [{"name": n, "type": "String"} for n in
                ("TraceId", "SpanId", "ParentSpanId", "ServiceName", "Timestamp", "Duration",
                 "ResourceAttributes", "SpanAttributes")]


class FakeConn:
    """Returns by SQL substring; records inserts/deletes. Tracks diag-signal writes (`inserts`/
    `deletes`, unchanged names/meaning from before this feature) and graph-query writes
    (`graph_inserts`/`graph_deletes`, new) independently, since the two tables have independent
    schema-version hashes and independent skip-on-unchanged behavior."""
    def __init__(self, *, kind="prometheus", metrics=PROM_METRICS, schema_present=True,
                 schema=None, existing_version=None, existing_graph_version=None,
                 existing_rows=None, fail_list_read=False, existing_budget=None):
        self.kind, self.metrics, self.schema_present = kind, metrics, schema_present
        self._schema_override = schema
        self.existing_version = existing_version
        self.existing_graph_version = existing_graph_version
        self.existing_rows = existing_rows or []
        self.fail_list_read = fail_list_read
        self.existing_budget = existing_budget
        self.inserts, self.deletes = [], []
        self.graph_inserts, self.graph_deletes = [], []
        self.schema_writes = []
        self.generated_version_touches = []

    def run(self, sql, **p):
        if "FROM datasource_schemas" in sql:
            if not self.schema_present:
                return []
            schema = self._schema_override if self._schema_override is not None else \
                {"metrics": self.metrics, "version": "2.50"}
            return [[self.kind, json.dumps(schema)]]
        if "COUNT(DISTINCT schema_version)" in sql and "datasource_diag_signals" in sql:
            return [[1, self.existing_version]] if self.existing_version is not None else [[0, None]]
        if "COUNT(DISTINCT schema_version)" in sql and "datasource_graph_queries" in sql:
            return [[1, self.existing_graph_version]] if self.existing_graph_version is not None else [[0, None]]
        if "SELECT meta FROM datasource_diag_signals" in sql:
            if p.get("sk") == wdb.BUDGET_KEY:
                return [[json.dumps({"budget": self.existing_budget})]] if self.existing_budget else []
            return []
        if "FROM datasource_diag_signals" in sql and "SELECT" in sql and "COUNT" not in sql:
            if self.fail_list_read:
                raise RuntimeError("transient read error")
            return [[r["signal_key"], r.get("title"), r["status"], json.dumps(r.get("query")),
                     None, json.dumps(r.get("meta"))] for r in self.existing_rows]
        if sql.strip().startswith("INSERT INTO datasource_diag_signals"):
            self.inserts.append(p); return []
        if sql.strip().startswith("DELETE FROM datasource_diag_signals"):
            self.deletes.append(p); return []
        if sql.strip().startswith("INSERT INTO datasource_graph_queries"):
            self.graph_inserts.append(p); return []
        if sql.strip().startswith("DELETE FROM datasource_graph_queries"):
            self.graph_deletes.append(p); return []
        if sql.strip().startswith("INSERT INTO datasource_schemas"):
            self.schema_writes.append(p); return []
        if sql.strip().startswith("UPDATE datasource_diag_signals"):
            self.generated_version_touches.append(p); return []
        return []

    def budget(self):
        """The `meta.budget` marker this call actually wrote for the dedicated budget row, or None if the
        call didn't write one (a settled outcome deliberately keeps none — see _rebuild_diag_signals)."""
        for p in self.inserts:
            if p.get("sk") == wdb.BUDGET_KEY:
                return json.loads(p["me"]).get("budget")
        return None

    def budget_row_status(self):
        for p in self.inserts:
            if p.get("sk") == wdb.BUDGET_KEY:
                return p.get("st")
        return None


class TestRebuildOnChange:
    def test_changed_schema_builds_upserts_and_sweeps(self):
        c = FakeConn(existing_version="STALE")
        out = dsi.run({"integration_id": 7}, c)
        assert out["built"] == 8 and out.get("skipped") is not True
        assert len(c.inserts) == 8                 # one upsert per signal
        assert len(c.deletes) == 1                 # one mark-sweep
        assert all(p["iid"] == 7 for p in c.inserts)

    def test_unchanged_schema_skips_rebuild(self):
        # build once to learn the deterministic version, then feed it back as existing
        c0 = FakeConn(existing_version="STALE")
        dsi.run({"integration_id": 7}, c0)
        version = c0.inserts[0]["sv"]
        c = FakeConn(existing_version=version)
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("skipped") is True
        assert c.inserts == [] and c.deletes == []

    def test_hash_is_stable_across_calls(self):
        a = FakeConn(existing_version="x"); dsi.run({"integration_id": 1}, a)
        b = FakeConn(existing_version="y"); dsi.run({"integration_id": 1}, b)
        assert a.inserts[0]["sv"] == b.inserts[0]["sv"]  # deterministic (sha256, not salted hash())


class TestEmptyVsError:
    def test_missing_cache_preserves_rows_and_skips(self):
        c = FakeConn(schema_present=False)
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("no_schema") is True
        assert c.inserts == [] and c.deletes == []   # preserve last-good; no destructive sweep

    def test_present_but_empty_metrics_rebuilds_all_unavailable(self):
        c = FakeConn(metrics=[], existing_version="STALE")
        out = dsi.run({"integration_id": 7}, c)
        assert len(c.inserts) == 8
        assert all(p["st"] == "unavailable" for p in c.inserts)  # not preserved — rebuilt unavailable
        assert len(c.deletes) == 1


class TestDefensive:
    def test_never_raises_on_conn_error(self):
        class Boom:
            def run(self, *a, **k):
                raise RuntimeError("db down")
        out = dsi.run({"integration_id": 7}, Boom())
        assert out.get("error")  # surfaced, not raised

    def test_non_prom_kind_now_builds_diag_signals_too(self):
        # loki has its own kind-scoped catalog entries (signal_catalog.py) — no longer skipped.
        c = FakeConn(kind="loki", schema={"labels": ["job", "namespace"]})
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert "skipped_kind" not in out
        assert out.get("built", 0) > 0
        assert any(p["st"] == "ready" for p in c.inserts)


def prev_base(dsi_mod):
    """A different schema's hash — the marker must be read whatever version prefixes it."""
    return dsi_mod._schema_version({"labels": ["other"]})


class TestGeneratedFallback:
    def test_fallback_invoked_and_appended_when_catalog_has_zero_ready(self, monkeypatch):
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda kind, schema, iid, invoke_connector, invoke_llm=None: ({
                "signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
                "query": {"tool": "loki_query_range", "queries": [{"label": "g", "expr": "count_over_time({job=\"x\"}[5m])"}]},
                "missing_metrics": None, "meta": {"kind": "loki", "provenance": "generated"},
            }, "generated")),
        }))
        # a loki schema with NO recognized labels ("job"/"namespace") → catalog itself has zero ready
        c = FakeConn(kind="loki", schema={"labels": ["custom_label_only"]})
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert any(p["sk"] == "generated_signal" for p in c.inserts)
        assert out["built"] == 4  # 3 catalog rows (all unavailable) + 1 generated
        assert out["ready"] == 1  # only the generated row is ready

    def test_transient_generation_failure_stores_a_mismatching_version_so_the_next_run_retries(self, monkeypatch):
        # A Bedrock throttle or a connector outage is retryable: recording the REAL version would freeze
        # it into a permanent skip, since the schema never changes (review finding).
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        base = dsi._schema_version({"tables": {"t": ["c"]}})
        c = FakeConn(kind="clickhouse", schema={"tables": {"t": ["c"]}})  # catalog yields nothing
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert out["schema_version"] == base and out.get("retry")   # content: always the plain, real version
        assert c.budget() == f"{base}:pend1w{dsi._iso_week()}"      # budget: the marker, separately

    def test_transient_failure_with_unavailable_catalog_rows_also_retries(self, monkeypatch):
        # The first version of this guard only fired on an EMPTY build, so loki/tempo — which normally
        # produce `unavailable` rows — persisted those under the real version and skipped the retry just
        # as effectively (review, second pass). The rows are still written (the UI shows their "metric X
        # missing" text); only the version is tagged.
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        base = dsi._schema_version({"labels": ["custom_label_only"]})
        c = FakeConn(kind="loki", schema={"labels": ["custom_label_only"]})  # rows, none ready
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert out["built"] > 0 and out["ready"] == 0
        assert out["schema_version"] == base and out.get("retry")
        assert c.inserts and c.budget() == f"{base}:pend1w{dsi._iso_week()}"

    def test_the_retry_is_bounded(self, monkeypatch):
        # The connectors collapse upstream failures into the same 400 as a bad query, so the cause cannot be
        # read off the response — an unbounded `:retry` meant daily Bedrock calls for a query that may never
        # work (review, tenth pass). Once _MAX_GENERATION_ATTEMPTS tries are used up the instance is parked
        # for the rest of the ISO week — `:spent<week>`, not the plain version, so the park expires.
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        base = dsi._schema_version({"tables": {"t": ["c"]}})
        c = FakeConn(kind="clickhouse", schema={"tables": {"t": ["c"]}},
                     existing_budget=f"{base}:pend{dsi._MAX_GENERATION_ATTEMPTS - 1}w{dsi._iso_week()}")
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        spent = f"{base}:done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}"
        assert out["schema_version"] == base and not out.get("retry")
        assert c.budget().startswith(spent)

    def test_the_generation_runs_exactly_max_attempts_times(self, monkeypatch):
        # _MAX_GENERATION_ATTEMPTS counts GENERATIONS, not extra ones: `:retryN` already means N ran, so
        # comparing N (rather than N+1) against the cap spent one attempt more than the name promises.
        calls = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
        }))
        schema = {"tables": {"t": ["c"]}}
        base = dsi._schema_version(schema)
        budget = None
        for _ in range(10):   # more runs than the cap: the extra ones must not generate again
            c = FakeConn(kind="clickhouse", schema=schema, existing_budget=budget)
            dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
            budget = c.budget()
        assert budget.startswith(f"{base}:done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}")
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS

    def test_the_catalog_version_retires_the_ambiguous_plain_marker(self, monkeypatch):
        """v3 wrote the PLAIN hash for an exhausted budget, which reads exactly like the legitimate
        "conclusively nothing to build" row that must keep skipping — so such a row would never generate
        again (Codex stop-gate). The only way out is to invalidate every hash once."""
        assert dsi._cat.CATALOG_VERSION == "v5", "bump the catalog version to retire v3's plain-hash marker"
        schema = {"tables": {"t": ["c"]}}
        now = dsi._schema_version(schema)
        monkeypatch.setattr(dsi._cat, "CATALOG_VERSION", "v3")
        assert dsi._schema_version(schema) != now   # every v3 row, plain marker included, rebuilds once

    def test_the_catalog_version_forces_a_one_time_rebuild_for_v4_instances(self, monkeypatch):
        """v4's marker lived embedded in schema_version itself; v5 moved it to a dedicated bookkeeping row.
        The bump forces every v4 row's CONTENT to look stale once, so the transition is a deliberate
        rebuild rather than a false permanent skip (a v4 row's stored value is never a valid v5 hash)."""
        schema = {"tables": {"t": ["c"]}}
        now = dsi._schema_version(schema)
        monkeypatch.setattr(dsi._cat, "CATALOG_VERSION", "v4")
        assert dsi._schema_version(schema) != now

    def test_a_pre_v5_capped_instance_does_not_get_a_free_budget_on_rollout(self, monkeypatch):
        """The CATALOG_VERSION bump alone does not preserve a cap — it only makes the CONTENT mismatch, so
        without also bootstrapping the budget, `read_diag_signal_budget` finds no dedicated row (no pre-v5
        instance has one) and every already-parked instance reads as fresh, a hard-cap violation across
        the whole fleet at once on the very first post-deploy run (Codex stop-gate). A pre-v5 row's
        schema_version literally IS the old embedded marker string — bootstrapping the budget from it this
        one time carries the real attempts/streak forward instead of resetting them."""
        calls = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
        }))
        schema = {"tables": {"t": ["c"]}}
        # A pre-v5 row: no dedicated budget row exists, and CONTENT itself carries the old embedded marker
        # — capped, with no budget left, under the OLD (v4-scheme) hash.
        legacy_embedded = f"legacy-v4-hash:done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}s2"
        c = FakeConn(kind="clickhouse", schema=schema, existing_version=legacy_embedded)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert calls == []                    # still capped — bootstrapped, not reset to a fresh budget
        assert c.budget() is not None and c.budget().endswith(f"s2")

    def test_a_pre_v5_streak_capped_row_stays_parked_across_a_week_rollover(self, monkeypatch):
        """Carrying the OLD embedded hash prefix over VERBATIM fixed the same-week case but broke the
        streak-cap's week-rollover un-park check: a pre-v5 marker's hash was computed under the OLD
        CATALOG_VERSION, so it can never equal a freshly computed v5 hash even for an IDENTICAL, unchanged
        schema — `base != version` reads as "the schema genuinely changed" and un-parks every streak-capped
        pre-v5 instance the moment the week rolls, purely because of this deploy's version-scheme change
        (Codex stop-gate, second pass). The bootstrap must re-anchor the hash to the CURRENT version so the
        streak cap only reacts to a REAL schema change from here on."""
        calls = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
        }))
        schema = {"tables": {"t": ["c"]}}          # same schema before and after — never actually changes
        legacy_embedded = (f"legacy-v4-hash:done{dsi._MAX_GENERATION_ATTEMPTS}"
                           f"w200001s{dsi._MAX_SPENT_WEEKS}")
        monkeypatch.setattr(dsi, "_iso_week", lambda: "200002")   # a new week: the streak-cap branch fires
        c = FakeConn(kind="clickhouse", schema=schema, existing_version=legacy_embedded)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert calls == []                          # still capped — NOT treated as a genuine schema change
        assert c.budget() is None or c.budget().endswith(f"s{dsi._MAX_SPENT_WEEKS}")

    GENERATED_ROW = {"signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
                     "query": {"tool": "loki_query_range",
                               "queries": [{"label": "generated",
                                            "expr": 'count_over_time({job="a"} |= "error" [5m])'}]},
                     "meta": {"kind": "loki", "provenance": "generated"}}

    def test_a_failed_reverification_keeps_the_last_good_generated_chip(self, monkeypatch):
        """The rebuild is mark-and-sweep, so a chip generated last week was DELETED the moment the weekly
        retry hit a connector blip — a transient outage permanently removing verified content (MAJOR-2)."""
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
            "still_relevant": staticmethod(lambda *a: True),
        }))
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        schema = {"labels": ["custom_only"]}        # loki catalog matches nothing → fallback-only
        c = FakeConn(kind="loki", schema=schema, existing_rows=[self.GENERATED_ROW])
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert any(p["sk"] == "generated_signal" and p["st"] == "ready" for p in c.inserts)

    def test_a_stale_generated_chip_is_not_resurrected(self, monkeypatch):
        """Carrying it over must not resurrect one whose table/metric has since disappeared."""
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
            "still_relevant": staticmethod(lambda *a: False),
        }))
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        c = FakeConn(kind="loki", schema={"labels": ["custom_only"]}, existing_rows=[self.GENERATED_ROW])
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert not any(p["sk"] == "generated_signal" for p in c.inserts)

    def test_the_flag_being_off_stops_serving_the_generated_chip(self, monkeypatch):
        """Preservation is part of the feature, so it is gated like the feature: with the flag off an LLM row
        stayed alive indefinitely after the gate closed (Codex stop-gate)."""
        monkeypatch.delenv("DIAG_SIGNAL_QUERYGEN_ENABLED", raising=False)
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "disabled")),
            "still_relevant": staticmethod(lambda *a: True),
        }))
        c = FakeConn(kind="loki", schema={"labels": ["custom_only"]}, existing_rows=[self.GENERATED_ROW])
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert not any(p["sk"] == "generated_signal" for p in c.inserts)

    def test_a_parked_week_does_not_sweep_the_chip_away(self, monkeypatch):
        """The park skips generation entirely, so without preservation the park itself deleted the chip —
        the same deletion MAJOR-2 was about."""
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: pytest.fail("must not generate while parked")),
            "still_relevant": staticmethod(lambda *a: True),
        }))
        schema = {"labels": ["custom_only"]}
        base = dsi._schema_version(schema)
        parked = f"{base}:pend{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}"
        c = FakeConn(kind="loki", schema=schema, existing_budget=parked,
                     existing_rows=[self.GENERATED_ROW])
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert any(p["sk"] == "generated_signal" and p["st"] == "ready" for p in c.inserts)

    def test_a_generated_only_build_settles_instead_of_regenerating_forever(self, monkeypatch):
        """A kind whose deterministic catalog is ALWAYS empty (clickhouse) can end up with the generated
        row as the ONLY row in the table. A version-blind exclusion of that key from
        read_signal_schema_version() left zero rows to check in that case, reading as permanently
        version-less and regenerating on every single call forever (review, this round)."""
        calls = []
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(dsi._cat, "build_signals", lambda kind, schema: [])
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "GENERATED_SIGNAL_KEY": "generated_signal",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (
                calls.append(1),
                ({"signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
                  "query": {"tool": "clickhouse_query", "queries": [{"label": "g", "expr": "SELECT 1"}]},
                  "missing_metrics": None, "meta": {"kind": "clickhouse", "provenance": "generated"}},
                 "generated"))[1]),
        }))
        schema = {"tables": [{"name": "spans", "columns": [{"name": "duration"}]}]}
        base = dsi._schema_version(schema)
        version = None
        for _ in range(3):
            c = FakeConn(kind="clickhouse", schema=schema, existing_version=version)
            version = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)["schema_version"]
        assert len(calls) == 1              # generated once, then settled — not once per run
        assert version == base              # plain version, readable back every time

    def test_a_read_failure_while_parked_does_not_sweep_the_chip(self, monkeypatch):
        """The carry-over exists so a connector blip doesn't destroy a verified chip (MAJOR-2). While parked
        (exhausted this week — no new Bedrock attempt this call), a failed carry-over read must not let the
        sweep delete the row it couldn't verify: GENERATED_SIGNAL_KEY is always spared from the sweep
        whenever it wasn't confirmed this call, regardless of whether the write itself still proceeds."""
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "GENERATED_SIGNAL_KEY": "generated_signal",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: pytest.fail("must not generate while parked")),
            "still_relevant": staticmethod(lambda *a: True),
        }))
        schema = {"labels": ["custom_only"]}
        base = dsi._schema_version(schema)
        parked = f"{base}:pend{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}"
        c = FakeConn(kind="loki", schema=schema, existing_budget=parked,
                     existing_rows=[self.GENERATED_ROW], fail_list_read=True)
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert not any(d.get("keep") and "generated_signal" not in d["keep"] for d in c.deletes)

    def test_a_read_failure_after_a_charged_attempt_still_records_the_spend_and_spares_the_chip(
            self, monkeypatch):
        """A read failure must not become a free retry loop, AND must not delete the last-known-good chip —
        fixing one broke the other across two prior review rounds. When an attempt WAS just made
        (charged), its cost is recorded (bounding the budget) while the unverifiable row is still spared
        from the sweep (protecting the chip)."""
        calls = []
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "GENERATED_SIGNAL_KEY": "generated_signal",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
            "still_relevant": staticmethod(lambda *a: True),
        }))
        schema = {"labels": ["custom_only"]}
        base = dsi._schema_version(schema)
        budget = None
        for _ in range(10):    # persistent read failure across many runs must NOT mean 10 Bedrock calls
            c = FakeConn(kind="loki", schema=schema, existing_budget=budget,
                         existing_rows=[self.GENERATED_ROW], fail_list_read=True)
            dsi.run({"integration_id": 7, "kind": "loki"}, c)
            budget = c.budget()
            assert not any(d.get("keep") and "generated_signal" not in d["keep"] for d in c.deletes)
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS      # bounded, not one per run
        assert budget.startswith(f"{base}:done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}")

    def test_a_genuine_schema_change_unparks_a_streak_capped_instance(self, monkeypatch):
        """The comment says a streak-capped instance 'stays settled until its schema changes' — but the
        caller only used `base == version` for the SKIP check, not for the exhaustion check, so a genuinely
        new schema arriving after the park stayed blocked forever (review MAJOR, this round)."""
        calls = []
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
            "still_relevant": staticmethod(lambda *a: True),
        }))
        old_schema = {"labels": ["custom_only"]}
        old_base = dsi._schema_version(old_schema)
        parked = f"{old_base}:done{dsi._MAX_GENERATION_ATTEMPTS}w200001s{dsi._MAX_SPENT_WEEKS}"
        monkeypatch.setattr(dsi, "_iso_week", lambda: "200002")   # a new week, still capped for the OLD schema
        c_same = FakeConn(kind="loki", schema=old_schema, existing_budget=parked)
        dsi.run({"integration_id": 7, "kind": "loki"}, c_same)
        # unchanged schema: still parked, no call — the week component refreshes to "last confirmed", but
        # the hash/attempts/streak that actually matter for cost/identity are untouched
        assert c_same.budget() == f"{old_base}:done{dsi._MAX_GENERATION_ATTEMPTS}w200002s{dsi._MAX_SPENT_WEEKS}"
        assert calls == []

        new_schema = {"labels": ["different_label"]}              # a genuinely NEW schema
        c_new = FakeConn(kind="loki", schema=new_schema, existing_budget=parked)
        dsi.run({"integration_id": 7, "kind": "loki"}, c_new)
        assert calls == [1]                                       # unparked: the new schema gets a try
        assert c_new.budget().startswith(f"{dsi._schema_version(new_schema)}:pend1w")

    def test_the_flag_being_off_does_not_spend_the_budget(self, monkeypatch):
        """DISABLED means no Bedrock call happened. Charging for it exhausted the week with the feature OFF,
        and since `attempts` is read whatever hash prefixes the marker, turning the flag ON was then a no-op
        for up to a week — the flag change rebuilds, but the instance already read as exhausted."""
        calls = []
        disabled = type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append("off"), (None, "disabled"))[1]),
        })
        monkeypatch.setattr(dsi, "_signal_gen", disabled)
        schema = {"metrics": ["custom_only"]}
        version = None
        for i in range(4):                      # drifting schema, flag off: rebuilds but never charges
            drifting = {"metrics": ["custom_only", f"m{i}"]}
            c = FakeConn(kind="prometheus", schema=drifting, existing_version=version)
            version = dsi.run({"integration_id": 7, "kind": "prometheus"}, c)["schema_version"]
        base = dsi._schema_version({"metrics": ["custom_only", "m3"]})   # last drifting schema, i=3
        assert version == base     # plain — DISABLED settles immediately, no marker needed

        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {   # operator turns the flag on
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append("on"), (None, "transient"))[1]),
        }))
        c = FakeConn(kind="prometheus", schema={"metrics": ["custom_only", "m9"]}, existing_version=version)
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert calls.count("on") == 1 and c.budget().endswith(f":pend1w{dsi._iso_week()}")

    def test_the_weekly_budget_survives_ordinary_churn_while_actively_retrying(self, monkeypatch):
        """The version hashes the whole schema and a production Prometheus changes its metric set on every
        deploy, so keying the cap to the version turned "3 tries a week" into a daily Bedrock call (review
        MAJOR-3). A PEND marker (an attempt cycle in progress, budget not yet spent) reads attempts
        regardless of which hash prefixes it — this is the property that survives churn; a DONE marker's
        behaviour is covered separately (see the settle/unpark tests below)."""
        calls = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
        }))
        budget = None
        for i in range(dsi._MAX_GENERATION_ATTEMPTS):    # a different schema — hence version — every call
            drifting = {"metrics": ["custom_only", f"new_metric_{i}"]}
            c = FakeConn(kind="prometheus", schema=drifting, existing_budget=budget)
            dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
            budget = c.budget()
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS   # not one per run
        assert f":done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}" in budget

        # Once DONE, a call against the SAME (now-stable) schema must stay capped — this is the actual
        # MAJOR-3 invariant: a repeatedly-failing, UNCHANGING schema does not retry again this week.
        stable_schema = {"metrics": ["custom_only", f"new_metric_{dsi._MAX_GENERATION_ATTEMPTS - 1}"]}
        c = FakeConn(kind="prometheus", schema=stable_schema, existing_budget=budget)
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS   # still capped — no 4th call

    def test_a_mid_week_schema_change_still_waits_for_the_hard_weekly_cap(self, monkeypatch):
        """The weekly budget is a HARD per-INSTANCE ceiling (ADR-018 §B-4: "인스턴스당 ISO 주 3회"), not a
        per-schema one. Un-parking on ANY same-week hash mismatch — tried once — let a schema that
        genuinely changes N times in one week grant a fresh 3-try budget N times: 3N Bedrock calls in a
        single week, straight through the cap (review, this round: reverted). Once this week's budget is
        spent, a real schema change still has to wait for the week to roll, exactly like an unchanged
        schema would — only the multi-week streak-cap boundary compares hashes, and only because that
        never spends a SECOND budget within one week (see test above)."""
        calls = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
        }))
        budget = None
        for i in range(dsi._MAX_GENERATION_ATTEMPTS):   # same schema each call, in-progress retry cycle
            c = FakeConn(kind="prometheus", schema={"metrics": ["custom_only"]}, existing_budget=budget)
            dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
            budget = c.budget()
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS
        assert f":done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}" in budget   # parked this week

        new_schema = {"metrics": ["genuinely_different"]}                # a real change, same ISO week
        c = FakeConn(kind="prometheus", schema=new_schema, existing_budget=budget)
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS                 # NOT unparked — the week isn't over
        assert c.budget() == budget   # byte-for-byte preserved — the marker's identity does not
        # drift to the untried schema; see the next test for why that matters.

    def test_a_never_tried_schema_is_not_silently_absorbed_into_an_old_cap(self, monkeypatch):
        """Re-stamping the marker with the CURRENT schema's hash while doing nothing new (exhausted, no
        attempt this call) made a schema that was NEVER evaluated look, from the very next read, exactly
        like "tried 3 times and failed" for THAT schema — the next week's streak-cap hash check then
        compared against a hash that never got a real try, so the untried schema stayed parked
        indefinitely for as long as it happened to stay stable (review, this round)."""
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        old_schema = {"metrics": ["custom_only"]}
        old_hash = dsi._schema_version(old_schema)
        capped = f"{old_hash}:done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}s{dsi._MAX_SPENT_WEEKS}"
        new_schema = {"metrics": ["never_tried"]}          # arrives mid-week, while capped — never evaluated
        c = FakeConn(kind="prometheus", schema=new_schema, existing_budget=capped)
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert c.budget() == capped                        # unchanged: new_schema's hash never absorbed in

        # Next week: the streak-cap check must compare against the OLD (never-tried-against) hash, not
        # new_schema's — so it correctly un-parks and gives new_schema its first real try.
        monkeypatch.setattr(dsi, "_iso_week", lambda: "209952")
        calls = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
        }))
        c2 = FakeConn(kind="prometheus", schema=new_schema, existing_budget=c.budget())
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c2)
        assert calls == [1]        # new_schema finally gets its first try — not parked indefinitely

    def test_a_schema_rollback_is_not_masked_by_a_preserved_budget_marker(self, monkeypatch):
        """Sharing one column between content-freshness and budget tracking meant every fix that preserved
        the budget's identity (a stale marker, or excluding a key from the version-agreement check) also
        tagged the CONTENT rows with a version that didn't describe them. If the schema then rolled BACK to
        whatever that stale tag actually named, the agreement check saw a false match and skipped — serving
        the newer, mistagged content as if it were the OLD schema's real signals (Codex stop-gate). Since
        content and budget are now tracked in separate columns, content is free to always carry the truth."""
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        schema_b = {"metrics": ["custom_only"]}                     # exhausted and capped
        base_b = dsi._schema_version(schema_b)
        capped_b = f"{base_b}:done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}s{dsi._MAX_SPENT_WEEKS}"
        schema_c = {"metrics": ["never_evaluated"]}                 # arrives mid-week, while B is capped
        base_c = dsi._schema_version(schema_c)

        c1 = FakeConn(kind="prometheus", schema=schema_c, existing_version=base_b, existing_budget=capped_b)
        out1 = dsi.run({"integration_id": 7, "kind": "prometheus"}, c1)
        # Check what was ACTUALLY WRITTEN (`p["sv"]`), not just the return value — the function always
        # reports the real `version` in its return dict, so only the DB write itself can catch mistagging.
        assert c1.inserts and all(p["sv"] == base_c for p in c1.inserts)   # content correctly tags C's rows
        assert c1.budget() == capped_b                     # budget stays B's — C was never actually tried

        # The schema now rolls BACK to B. If content had been tagged with the preserved (B) marker instead
        # of C's real hash, this read would falsely "match" and skip, serving C's stale rows as B's.
        c2 = FakeConn(kind="prometheus", schema=schema_b, existing_version=base_c, existing_budget=c1.budget())
        out2 = dsi.run({"integration_id": 7, "kind": "prometheus"}, c2)
        assert out2.get("skipped") is not True              # must rebuild — content (C) does not match B
        assert c2.inserts and all(p["sv"] == base_b for p in c2.inserts)  # B's rows correctly tagged

    def test_the_budget_row_uses_a_status_the_db_check_constraint_actually_allows(self, monkeypatch):
        """datasource_diag_signals has `CHECK (status IN ('ready', 'unavailable'))`. Writing 'disabled' for
        the budget row — a try_generate_signal_with_status() return VALUE, not a valid row status — would
        violate that constraint on every real Postgres write, so the budget could never actually persist
        (Codex stop-gate); the mock-based FakeConn never validates the constraint, which is why no other
        test caught it."""
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        c = FakeConn(kind="clickhouse", schema={"tables": {"t": ["c"]}})
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert c.budget_row_status() in ("ready", "unavailable")

    def test_a_rejected_answer_parks_for_the_week_and_does_not_freeze(self, monkeypatch):
        """The model is not deterministic and the gates change, so "failed a gate once" is not a permanent
        fact about the schema. Recording the plain version for REJECTED froze the instance until the schema
        drifted (review CRITICAL)."""
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "rejected")),
        }))
        schema = {"tables": {"t": ["c"]}}
        base = dsi._schema_version(schema)
        c = FakeConn(kind="clickhouse", schema=schema)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert out["schema_version"] == base                      # content: always the real version
        assert c.budget() == f"{base}:pend1w{dsi._iso_week()}"     # budget: not conclusive — retryable

    def test_a_weekless_legacy_marker_reads_as_a_fresh_budget(self, monkeypatch):
        # An earlier commit wrote `:retryN` with no week. It must not park the instance — reading it as a
        # fresh budget is the safe direction, and the plain-hash "gave up" encoding cannot reach this code
        # from a deployed row because the hash basis itself changed in this commit.
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        schema = {"tables": {"t": ["c"]}}
        base = dsi._schema_version(schema)
        c = FakeConn(kind="clickhouse", schema=schema, existing_budget=f"{base}:retry2")
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert c.budget() == f"{base}:pend1w{dsi._iso_week()}"

    def test_a_settled_week_skips_instead_of_rebuilding_daily(self, monkeypatch):
        """A `done` marker means the week is settled, so the daily job skips outright. The earlier encoding
        stored a value that never equalled the plain version, which rebuilt the instance every single day
        (cheap, but pointless churn); and a park that never converged was the Codex stop-gate finding."""
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        schema = {"labels": ["job"]}
        base = dsi._schema_version(schema)
        settled = f"{base}:done{dsi._MAX_GENERATION_ATTEMPTS}w{dsi._iso_week()}"
        c = FakeConn(kind="loki", schema=schema, existing_version=base, existing_budget=settled)
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert out.get("skipped") is True and c.inserts == []
        monkeypatch.setattr(dsi, "_iso_week", lambda: "209952")   # week rolls → one rebuild, no Bedrock
        c2 = FakeConn(kind="loki", schema=schema, existing_version=base, existing_budget=settled)
        out2 = dsi.run({"integration_id": 7, "kind": "loki"}, c2)
        assert any(p["st"] == "ready" for p in c2.inserts)          # the catalog matches this schema
        # a READY outcome is fully conclusive — plain version, no marker at all (no more weekly re-checks;
        # see test_a_ready_outcome_settles_with_the_plain_version for why that matters)
        assert out2["schema_version"] == base and c2.budget() is None

    def test_a_ready_outcome_settles_with_the_plain_version(self, monkeypatch):
        """A conclusive (ready) outcome gets the PLAIN version, not a marker — storing a marker for it was
        the other MAJOR this round found: the marker's week ages out every ISO week, `done` reverts to
        False, and the daily job called Bedrock again on an unchanged, already-successfully-served schema
        (directly contradicting ADR-018 §A-4/Sustainability, "cached, not regenerated every run"). Whatever
        budget usage preceded this outcome becomes moot — there is nothing left to retry."""
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        ready_schema = {"labels": ["job"]}                  # catalog matches → conclusive, no generation
        base = dsi._schema_version(ready_schema)
        c = FakeConn(kind="loki", schema=ready_schema, existing_budget=f"{base}:pend2w{dsi._iso_week()}")
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert out["schema_version"] == base and c.budget() is None

    def test_the_weekly_retry_is_capped_by_a_spent_week_streak(self, monkeypatch):
        """"The week rolls" must not mean retrying forever: with an unchanged schema that keeps failing, a
        weekly budget is unbounded Bedrock spend (review MAJOR-1/-7). After _MAX_SPENT_WEEKS consecutive
        spent weeks the instance stops until the SCHEMA changes — the only new information there is."""
        calls = []
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
            "still_relevant": staticmethod(lambda *a: True),
        }))
        schema = {"labels": ["custom_only"]}
        budget = None
        for week in range(1, 8):                      # seven weeks, same schema, always failing
            monkeypatch.setattr(dsi, "_iso_week", lambda w=week: f"20260{w}")
            for _ in range(dsi._MAX_GENERATION_ATTEMPTS + 1):
                c = FakeConn(kind="loki", schema=schema, existing_budget=budget)
                dsi.run({"integration_id": 7, "kind": "loki"}, c)
                budget = c.budget()
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS * dsi._MAX_SPENT_WEEKS
        assert budget.endswith(f"s{dsi._MAX_SPENT_WEEKS}")

    def test_a_ready_build_settles_even_after_a_spent_week_streak(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
            "still_relevant": staticmethod(lambda *a: True),
        }))
        schema = {"labels": ["job"]}                  # the loki catalog DOES match this
        base = dsi._schema_version(schema)
        c = FakeConn(kind="loki", schema=schema,
                     existing_budget=f"{base}:done{dsi._MAX_GENERATION_ATTEMPTS}w200001s2")
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert out["schema_version"] == base and c.budget() is None   # plain — the streak is moot once ready

    def test_the_park_expires_when_the_week_rolls_over(self, monkeypatch):
        # It used to be permanent: the plain version was stored, and since a quiet datasource's schema never
        # changes, an instance idle for three runs stayed chip-less forever (review MAJOR, L4-M3).
        calls = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (calls.append(1), (None, "transient"))[1]),
        }))
        schema = {"tables": {"t": ["c"]}}
        base = dsi._schema_version(schema)
        monkeypatch.setattr(dsi, "_iso_week", lambda: "202601")
        budget = None
        for _ in range(5):
            c = FakeConn(kind="clickhouse", schema=schema, existing_budget=budget)
            dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
            budget = c.budget()
        assert budget.startswith(f"{base}:done{dsi._MAX_GENERATION_ATTEMPTS}w202601")
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS
        monkeypatch.setattr(dsi, "_iso_week", lambda: "202602")   # next week: a fresh budget
        c = FakeConn(kind="clickhouse", schema=schema, existing_budget=budget)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        # the spent-week streak rides along (s1) — the budget is fresh, the streak is what caps the weeks
        assert c.budget() == f"{base}:pend1w202602s1"
        assert len(calls) == dsi._MAX_GENERATION_ATTEMPTS + 1

    def test_the_attempt_counter_advances(self, monkeypatch):
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "transient")),
        }))
        base = dsi._schema_version({"tables": {"t": ["c"]}})
        c = FakeConn(kind="clickhouse", schema={"tables": {"t": ["c"]}},
                     existing_budget=f"{base}:pend1w{dsi._iso_week()}")
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert c.budget() == f"{base}:pend2w{dsi._iso_week()}"

    def test_conclusive_empty_build_records_the_sentinel(self, monkeypatch):
        # Flag off (or the model answered and was rejected): nothing will change until the schema or an
        # operator does, so the version IS recorded and the next run skips.
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda *a, **k: (None, "disabled")),
        }))
        c = FakeConn(kind="clickhouse", schema={"tables": {"t": ["c"]}})
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert out["schema_version"] is not None and not out["schema_version"].endswith(":retry")
        assert [p["sk"] for p in c.inserts] == ["__schema_version__"]

    def test_fallback_not_invoked_when_catalog_already_has_a_ready_row(self, monkeypatch):
        called = []
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(
                lambda *a, **k: (called.append(1) or None, "rejected")),
        }))
        c = FakeConn(kind="loki", schema={"labels": ["job"]})  # loki_error_count matches → 1+ ready
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert called == []


class TestSchemaVersionCoversFullSchemaAndFlag:
    """_schema_version used to hash only schema['metrics'], so non-metrics kinds (loki/clickhouse/
    tempo/jaeger) hashed to a CONSTANT — label/table drift and GRAPH_QUERYGEN_ENABLED flips never
    triggered a rebuild for them. Mirrors _graph_schema_version's existing flag-mixing precedent."""

    def test_flipping_the_diag_signal_flag_changes_the_version(self, monkeypatch):
        # The version mixed only GRAPH_QUERYGEN_ENABLED, so turning the NEW flag on left every
        # already-indexed instance's version unchanged → skip → the fallback never ran for exactly the
        # instances it was added for (review finding).
        schema = {"labels": ["job"]}
        monkeypatch.delenv("DIAG_SIGNAL_QUERYGEN_ENABLED", raising=False)
        off = dsi._schema_version(schema)
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        assert dsi._schema_version(schema) != off

    def test_label_only_schema_change_is_not_treated_as_unchanged(self):
        # loki schema has no "metrics" key at all — the old hash basis was a constant for this kind.
        c0 = FakeConn(kind="loki", schema={"labels": ["job"]})
        dsi.run({"integration_id": 7, "kind": "loki"}, c0)
        version = c0.inserts[0]["sv"]
        # Different labels, same existing_version recorded under the old (constant) hash — must NOT
        # be read as "unchanged" now that the full schema feeds the hash.
        c1 = FakeConn(kind="loki", schema={"labels": ["namespace"]}, existing_version=version)
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c1)
        assert out.get("skipped") is not True
        assert c1.inserts != []

    def test_flag_flip_with_unchanged_schema_forces_rebuild_not_skip(self, monkeypatch):
        schema = {"labels": ["custom_label_only"]}  # zero catalog matches → fallback-eligible
        # the DIAG flag, not the graph one: only the flag that changes THIS table's content is hashed
        monkeypatch.delenv("DIAG_SIGNAL_QUERYGEN_ENABLED", raising=False)
        c0 = FakeConn(kind="loki", schema=schema)
        dsi.run({"integration_id": 7, "kind": "loki"}, c0)
        version_off = c0.inserts[0]["sv"]
        assert not any(p["st"] == "ready" for p in c0.inserts)  # no fallback while the flag was off

        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(dsi, "_signal_gen", type("M", (), {
            "TRANSIENT": "transient", "REJECTED": "rejected", "DISABLED": "disabled",
            "try_generate_signal_with_status": staticmethod(lambda kind, schema, iid, invoke_connector, invoke_llm=None: ({
                "signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
                "query": {"tool": "loki_query_range", "queries": [{"label": "g", "expr": "x"}]},
                "missing_metrics": None, "meta": {"kind": "loki", "provenance": "generated"},
            }, "generated")),
        }))
        c1 = FakeConn(kind="loki", schema=schema, existing_version=version_off)
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c1)
        assert out.get("skipped") is not True
        assert any(p["sk"] == "generated_signal" for p in c1.inserts)

    def test_same_flag_state_and_schema_still_skips(self, monkeypatch):
        schema = {"labels": ["job"]}
        monkeypatch.delenv("DIAG_SIGNAL_QUERYGEN_ENABLED", raising=False)
        c0 = FakeConn(kind="loki", schema=schema)
        dsi.run({"integration_id": 7, "kind": "loki"}, c0)
        version = c0.inserts[0]["sv"]
        c1 = FakeConn(kind="loki", schema=schema, existing_version=version)
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c1)
        assert out.get("skipped") is True
        assert c1.inserts == []


# ── Task 11: end-to-end smoke — catalog → index(build) → diag_signals → collect → coverage "사용" ──
def test_e2e_index_to_collect_to_coverage(monkeypatch):
    """One worker-side flow with injected fixtures (no AWS): index builds ready signals → collect_datasources
    executes them → _coverage_note reports the datasource as '사용'."""
    import json as _json
    from diagnosis import sources as src
    from diagnosis import report as rpt

    # 1) index builds signals from a cached schema (capture the upserted ready rows)
    idx = FakeConn(existing_version="STALE")
    out_idx = dsi.run({"integration_id": 5}, idx)
    assert out_idx["ready"] >= 1
    built = [p for p in idx.inserts if p["st"] == "ready"]

    # 2) feed the built rows back as datasource_diag_signals + drive collect_datasources
    signal_rows = [[p["sk"], p["sk"], p["st"], p["q"], p["mm"], p["me"]] for p in idx.inserts]

    class FlowConn:
        def run(self, sql, **kw):
            if "FROM integrations" in sql:
                return [(5, "prod-prom", "prometheus", True)]
            if "FROM datasource_diag_signals" in sql:
                return signal_rows
            return []

    import io
    class FakeLambda:
        def invoke(self, FunctionName, Payload):  # noqa: N803
            env = _json.dumps({"statusCode": 200,
                               "body": _json.dumps({"result": {"shape": "vector", "series": [{"v": 1}]}})}).encode()
            return {"Payload": io.BytesIO(env)}
    monkeypatch.setenv("DIAG_DATASOURCES_ENABLED", "true")
    monkeypatch.setattr(src, "_lambda_client", lambda: FakeLambda())

    out = src.collect_datasources(FlowConn())
    assert out["ok"] and out["data"]["queried"] == 1
    assert out["data"]["findings"][0].get("source") == "signals"

    # 3) coverage note reports the datasource as used
    note = rpt._coverage_note({"datasources_obs": out})
    assert "사용" in note and "prod-prom" in note


class TestAccountKeyFallback:
    """M1: a BFF/worker HOST_ACCOUNT_ID mismatch must NOT blank the build — integration_id fallback."""
    def test_schema_found_via_integration_id_when_account_scope_misses(self):
        class MismatchConn:
            def __init__(self):
                self.inserts, self.deletes = [], []
                self.graph_inserts, self.graph_deletes = [], []
                self.schema_writes = []
            def run(self, sql, **p):
                if "FROM datasource_schemas" in sql:
                    # account-scoped query misses (BFF wrote under a different account key); fallback hits
                    if "account_id IN" in sql:
                        return []
                    return [["prometheus", json.dumps({"metrics": PROM_METRICS})]]
                if "COUNT(DISTINCT schema_version)" in sql:
                    return [[0, None]]
                if sql.strip().startswith("INSERT INTO datasource_diag_signals"):
                    self.inserts.append(p); return []
                if sql.strip().startswith("DELETE FROM datasource_diag_signals"):
                    self.deletes.append(p); return []
                if sql.strip().startswith("INSERT INTO datasource_graph_queries"):
                    self.graph_inserts.append(p); return []
                if sql.strip().startswith("DELETE FROM datasource_graph_queries"):
                    self.graph_deletes.append(p); return []
                return []
        c = MismatchConn()
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("built") == 8 and out.get("no_schema") is not True   # fallback found the schema
        assert len(c.inserts) == 8


def test_gate_off_no_build(monkeypatch):
    """M2: with the feature gate off, run() no-ops (no write) even though the job was enqueued."""
    monkeypatch.delenv("DIAG_DATASOURCES_ENABLED", raising=False)
    c = FakeConn(existing_version="STALE")
    out = dsi.run({"integration_id": 7}, c)
    assert out.get("disabled") is True
    assert c.inserts == [] and c.deletes == []
    assert c.graph_inserts == []


# ── Registry-driven graph sources (2026-07-08): pre-built topology-graph queries, all 5 kinds ──────
class TestGraphQueriesAllKinds:
    def test_clickhouse_builds_ready_trace_spans_from_matching_schema(self):
        schema = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}
        c = FakeConn(kind="clickhouse", schema=schema)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert len(c.graph_inserts) == 1
        assert c.graph_inserts[0]["st"] == "ready"
        assert out.get("graph_built") == 1 and out.get("graph_ready") == 1

    def test_tempo_builds_ready_trace_spans_whenever_introspected(self):
        c = FakeConn(kind="tempo", schema={"tags": ["service.name"]})
        dsi.run({"integration_id": 7, "kind": "tempo"}, c)
        assert c.graph_inserts and c.graph_inserts[0]["st"] == "ready"

    def test_prometheus_builds_ready_servicegraph_calls_when_metric_present(self):
        c = FakeConn(kind="prometheus", schema={"metrics": ["traces_service_graph_request_total"]})
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert c.graph_inserts and c.graph_inserts[0]["st"] == "ready"

    def test_loki_always_builds_two_unavailable_rows(self):
        c = FakeConn(kind="loki", schema={"labels": ["job"]})
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert len(c.graph_inserts) == 2
        assert all(p["st"] == "unavailable" for p in c.graph_inserts)

    def test_graph_build_skips_when_hash_unchanged(self):
        c0 = FakeConn(kind="tempo", schema={"tags": []})
        dsi.run({"integration_id": 7, "kind": "tempo"}, c0)
        gversion = c0.graph_inserts[0]["sv"]
        c = FakeConn(kind="tempo", schema={"tags": []}, existing_graph_version=gversion)
        out = dsi.run({"integration_id": 7, "kind": "tempo"}, c)
        assert c.graph_inserts == [] and out.get("graph_skipped") is True

    def test_graph_build_independent_of_diag_signal_build(self):
        # graph queries and diag signals are built from independent catalogs/tables — confirm both
        # run for loki now that it has its own diag-signal entries too (Task 4).
        c = FakeConn(kind="loki", schema={"labels": ["job", "namespace"]})
        out = dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert "skipped_kind" not in out
        assert len(c.graph_inserts) == 2  # graph queries: still always-unavailable for loki (graph_catalog.py)


# ── Live re-introspection (drift detection, 2026-07-08) ─────────────────────────────────────────────
class TestLiveReintrospection:
    def test_drift_detected_updates_schema_cache_and_uses_the_fresh_schema(self, monkeypatch):
        fresh = {"metrics": PROM_METRICS + ["new_metric"], "version": "2.51"}
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: fresh)
        c = FakeConn(existing_version="STALE")  # cached schema (v2.50) differs from fresh (v2.51)
        out = dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert len(c.schema_writes) == 1
        assert json.loads(c.schema_writes[0]["s"])["version"] == "2.51"
        assert out.get("introspect_error") is None

    def test_no_drift_does_not_rewrite_the_cache(self, monkeypatch):
        same = {"metrics": PROM_METRICS, "version": "2.50"}  # identical to the cached schema
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: same)
        c = FakeConn(existing_version="STALE")
        dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert c.schema_writes == []

    def test_introspection_failure_falls_back_to_the_cached_schema(self, monkeypatch):
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: None)
        c = FakeConn(existing_version="STALE")
        out = dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert out.get("introspect_error") == "introspect_failed"
        assert c.schema_writes == []
        assert out.get("built") == 8   # still built, from the cached schema

    def test_no_cache_and_no_kind_and_failed_introspection_is_no_schema(self):
        # default fixture stub (_reintrospect -> None) applies; no kind anywhere to even try with.
        c = FakeConn(schema_present=False)
        out = dsi.run({"integration_id": 7}, c)
        assert out.get("no_schema") is True

    def test_first_ever_run_uses_live_schema_when_no_cache_exists_yet(self, monkeypatch):
        # Brand-new instance: the BFF's warm-cache write hasn't landed (or failed), but the dispatcher
        # still knows the kind from `integrations` — live introspection alone is enough to build.
        fresh = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: fresh)
        c = FakeConn(kind="clickhouse", schema_present=False)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert out.get("no_schema") is not True
        assert len(c.graph_inserts) == 1
        assert len(c.schema_writes) == 1


# ── M1 regression: a connector error envelope must never be written back as a schema ────────────────
class TestReintrospectRejectsErrorEnvelopes:
    """_reintrospect must fall back to None (never propagate a bad body) when `_lambda_invoke`
    returns something that isn't shaped like the target kind's schema — e.g. a connector error
    envelope `{"error": "..."}` that happens to be a dict. Directly exercises `_looks_like_schema`/
    `_reintrospect`, independent of `_lambda_invoke`'s own statusCode/FunctionError checks below."""

    def test_error_dict_without_expected_key_is_rejected(self, monkeypatch):
        monkeypatch.setattr(dsi, "_lambda_invoke", lambda kind, tool, arguments=None: {"error": "bad request"})
        assert _REAL_REINTROSPECT("prometheus", 7) is None
        assert _REAL_REINTROSPECT("clickhouse", 7) is None

    def test_real_shaped_body_is_accepted(self, monkeypatch):
        monkeypatch.setattr(dsi, "_lambda_invoke", lambda kind, tool, arguments=None: {"metrics": ["up"]})
        assert _REAL_REINTROSPECT("prometheus", 7) == {"metrics": ["up"]}

    def test_lambda_invoke_exception_falls_back_to_none(self, monkeypatch):
        def boom(kind, tool, arguments=None):
            raise RuntimeError("connector down")
        monkeypatch.setattr(dsi, "_lambda_invoke", boom)
        assert _REAL_REINTROSPECT("clickhouse", 7) is None


class TestLambdaInvokeEnvelopeValidation:
    """_lambda_invoke must raise (never return the body) on a FunctionError or a non-2xx statusCode —
    the M1 root cause was that the caller trusted any dict body regardless of these signals."""

    class _FakeLambdaClient:
        def __init__(self, response):
            self._response = response

        def invoke(self, FunctionName, Payload):  # noqa: N803 — matches boto3's kwarg casing
            return self._response

    def _stub_boto3(self, monkeypatch, response):
        monkeypatch.setattr(dsi.boto3, "client", lambda service, region_name=None: self._FakeLambdaClient(response))

    def test_function_error_raises(self, monkeypatch):
        import io
        self._stub_boto3(monkeypatch, {"FunctionError": "Unhandled", "Payload": io.BytesIO(b"{}")})
        with pytest.raises(RuntimeError):
            dsi._lambda_invoke("prometheus", "prometheus_schema")

    def test_error_statuscode_raises(self, monkeypatch):
        import io
        body = json.dumps({"statusCode": 400, "body": json.dumps({"error": "bad request"})}).encode()
        self._stub_boto3(monkeypatch, {"Payload": io.BytesIO(body)})
        with pytest.raises(RuntimeError):
            dsi._lambda_invoke("prometheus", "prometheus_schema")

    def test_ok_statuscode_returns_body(self, monkeypatch):
        import io
        body = json.dumps({"statusCode": 200, "body": json.dumps({"metrics": ["up"]})}).encode()
        self._stub_boto3(monkeypatch, {"Payload": io.BytesIO(body)})
        assert dsi._lambda_invoke("prometheus", "prometheus_schema") == {"metrics": ["up"]}


# ── M2 regression: flipping GRAPH_QUERYGEN_ENABLED must force a graph-query rebuild ─────────────────
class TestGraphSchemaVersionMixesInQuerygenFlag:
    def test_flag_flip_with_unchanged_schema_forces_rebuild_not_skip(self, monkeypatch):
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}
        monkeypatch.delenv("GRAPH_QUERYGEN_ENABLED", raising=False)
        c0 = FakeConn(kind="clickhouse", schema=schema)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c0)
        version_off = c0.graph_inserts[0]["sv"]
        assert c0.graph_inserts[0]["st"] == "unavailable"  # no querygen call while the flag was off

        # Same schema, flag now on — must NOT read as "unchanged" and skip; a real generated row
        # (querygen stubbed here) must actually get built and persisted.
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        generated = {"query_key": "trace_spans", "status": "ready",
                     "query": {"tool": "clickhouse_query", "mapper": "otel_v1", "args_template": {"sql": "SELECT 1"}},
                     "missing": None, "meta": {"kind": "clickhouse", "provenance": "generated"}}
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans", lambda schema, iid, invoke: generated)
        c1 = FakeConn(kind="clickhouse", schema=schema, existing_graph_version=version_off)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c1)
        assert out.get("graph_skipped") is not True
        assert len(c1.graph_inserts) == 1
        assert c1.graph_inserts[0]["st"] == "ready"
        assert json.loads(c1.graph_inserts[0]["me"])["provenance"] == "generated"

    def test_same_flag_state_and_schema_still_skips(self, monkeypatch):
        # Sanity check the fix didn't just always-rebuild: unchanged schema AND unchanged flag state
        # must still skip, same as before this fix.
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}
        monkeypatch.delenv("GRAPH_QUERYGEN_ENABLED", raising=False)
        c0 = FakeConn(kind="clickhouse", schema=schema)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c0)
        version = c0.graph_inserts[0]["sv"]
        c1 = FakeConn(kind="clickhouse", schema=schema, existing_graph_version=version)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c1)
        assert out.get("graph_skipped") is True
        assert c1.graph_inserts == []


# ── MINOR fix regression: 256KB write-back cap must not sink the whole job ──────────────────────────
class TestSchemaWriteBackSizeCap:
    def test_oversized_fresh_schema_is_used_for_this_run_but_not_persisted(self, monkeypatch):
        huge = {"metrics": [f"metric_{i}" for i in range(50_000)]}  # comfortably over 256KB serialized
        assert len(json.dumps(huge).encode("utf-8")) > 256_000
        monkeypatch.setattr(dsi, "_reintrospect", lambda kind, iid: huge)
        c = FakeConn(existing_version="STALE")
        out = dsi.run({"integration_id": 7, "kind": "prometheus"}, c)
        assert out.get("schema_cache_skipped") == "oversized"
        assert c.schema_writes == []          # never persisted
        assert out.get("built") == 8           # still rebuilt from the fresh (just-not-cached) schema
        assert not out.get("error")


# ── Hybrid LLM fallback wiring (graph_querygen.py, registry-driven graph sources 2026-07-08) ───────
class TestGraphQuerygenHybridFallback:
    def test_catalog_unavailable_triggers_querygen_and_a_generated_row_wins(self, monkeypatch):
        generated = {"query_key": "trace_spans", "status": "ready",
                     "query": {"tool": "clickhouse_query", "mapper": "otel_v1", "args_template": {"sql": "SELECT 1"}},
                     "missing": None, "meta": {"kind": "clickhouse", "provenance": "generated"}}
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans", lambda schema, iid, invoke: generated)
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}  # no catalog match
        c = FakeConn(kind="clickhouse", schema=schema)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert len(c.graph_inserts) == 1
        assert c.graph_inserts[0]["st"] == "ready"
        assert __import__("json").loads(c.graph_inserts[0]["me"])["provenance"] == "generated"

    def test_querygen_is_never_called_when_the_catalog_already_matched(self, monkeypatch):
        calls = []
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans",
                             lambda schema, iid, invoke: calls.append(1))
        schema = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}  # standard shape → catalog ready
        c = FakeConn(kind="clickhouse", schema=schema)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert calls == []  # catalog already ready — no need to ask the model

    def test_querygen_returning_none_leaves_the_catalogs_unavailable_row_in_place(self, monkeypatch):
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans", lambda schema, iid, invoke: None)
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}
        c = FakeConn(kind="clickhouse", schema=schema)
        dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert len(c.graph_inserts) == 1
        assert c.graph_inserts[0]["st"] == "unavailable"

    def test_querygen_never_touched_for_non_clickhouse_kinds(self, monkeypatch):
        calls = []
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans",
                             lambda schema, iid, invoke: calls.append(1))
        c = FakeConn(kind="loki", schema={"labels": []})
        dsi.run({"integration_id": 7, "kind": "loki"}, c)
        assert calls == []

    def test_a_querygen_exception_never_breaks_the_catalog_based_rebuild(self, monkeypatch):
        def boom(schema, iid, invoke):
            raise RuntimeError("bedrock down")
        monkeypatch.setattr(dsi._querygen, "try_generate_clickhouse_trace_spans", boom)
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}
        c = FakeConn(kind="clickhouse", schema=schema)
        out = dsi.run({"integration_id": 7, "kind": "clickhouse"}, c)
        assert not out.get("error")  # the outer job must not fail
        assert len(c.graph_inserts) == 1 and c.graph_inserts[0]["st"] == "unavailable"
