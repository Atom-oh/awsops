"""Tests for signal_catalog_gen — LLM hybrid fallback invoked when a kind's deterministic catalog
(signal_catalog.build_signals) yields zero ready rows. Mirrors graph_querygen.py's test shape:
every external call (LLM, connector dry-run) is injectable, so these tests make zero real calls.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signal_catalog_gen as scg  # noqa: E402

SCHEMA = {"metrics": ["custom_app_requests_total", "custom_app_latency_seconds"]}


class TestGenerateQuery:
    def test_uses_the_injected_invoke_and_strips_markdown_fences(self):
        expr = scg._generate_expr("prometheus", SCHEMA, invoke=lambda p: "```\nrate(custom_app_requests_total[5m])\n```")
        assert expr == "rate(custom_app_requests_total[5m])"

    def test_prompt_includes_kind_and_schema_names(self):
        seen = {}
        def fake_invoke(prompt):
            seen["prompt"] = prompt
            return "rate(custom_app_requests_total[5m])"
        scg._generate_expr("prometheus", SCHEMA, invoke=fake_invoke)
        assert "custom_app_requests_total" in seen["prompt"] and "prometheus" in seen["prompt"]

    def test_strips_a_leading_language_tag_from_a_fenced_response(self):
        expr = scg._generate_expr("prometheus", SCHEMA, invoke=lambda p: "```promql\nrate(a[5m])\n```")
        assert expr == "rate(a[5m])"


class TestStaticCheck:
    def test_accepts_a_plausible_read_expression(self):
        assert scg._static_check("prometheus", "rate(x[5m])") is True

    def test_rejects_sql_mutating_keywords_for_clickhouse(self):
        assert scg._static_check("clickhouse", "DROP TABLE x") is False
        assert scg._static_check("clickhouse", "SELECT * FROM x; DROP TABLE x") is False

    def test_rejects_mutating_keywords_on_a_newline_or_paren_adjacent(self):
        assert scg._static_check("clickhouse", "select 1\ndrop table x") is False
        assert scg._static_check("clickhouse", "select * from t where a=1 and(drop)") is False

    def test_rejects_blank_or_non_string(self):
        assert scg._static_check("prometheus", "") is False
        assert scg._static_check("prometheus", None) is False


class TestDryRunCheck:
    def test_passes_when_the_connector_returns_without_error(self):
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"result": {"shape": "vector"}}) == (True, False)

    def test_fails_on_a_connector_exception(self):
        def boom(args):
            raise RuntimeError("down")
        assert scg._dry_run_check("prometheus", "up", 7, boom) == (False, True)  # transient: retry

    def test_fails_on_an_error_envelope_response(self):
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"error": "no such metric"}) == (False, False)

    def test_a_falsy_response_is_retryable(self):
        # No payload at all is not a verdict on the query either — same reasoning as the empty cases.
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: None) == (False, True)

    # A 200 carrying no rows is not evidence the query works: an invented metric name returns
    # `result: []`, and the signal would be stored as a ready chip that stays permanently empty
    # (review MAJOR, 2 models). The spec asks for a non-error, NON-EMPTY-shape response.
    def test_empty_results_are_retryable_not_conclusive(self):
        # A quiet window legitimately returns nothing; calling that conclusive froze the instance
        # signal-less until the schema drifted (review MAJOR). The vocabulary check rejects queries that
        # can never match; emptiness alone only means "not now".
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"data": {"result": []}}) == (False, True)
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"result": []}) == (False, True)

    def test_empty_loki_streams_and_tempo_traces_are_retryable(self):
        assert scg._dry_run_check("loki", '{job=~".+"}', 7, lambda args: {"data": {"streams": []}}) == (False, True)
        assert scg._dry_run_check("tempo", "{}", 7, lambda args: {"data": {"traces": []}}) == (False, True)

    def test_empty_envelopes_of_any_shape_are_retryable(self):
        assert scg._dry_run_check("clickhouse", "SELECT 1", 7, lambda args: {}) == (False, True)
        assert scg._dry_run_check("clickhouse", "SELECT 1", 7, lambda args: {"rows": []}) == (False, True)
        assert scg._dry_run_check("clickhouse", "SELECT 1", 7, lambda args: []) == (False, True)

    def test_passes_when_rows_are_actually_present(self):
        assert scg._dry_run_check("prometheus", "up", 7,
                                  lambda args: {"data": {"result": [{"value": [0, "1"]}]}})[0] is True
        assert scg._dry_run_check("loki", '{job=~".+"}', 7,
                                  lambda args: {"data": {"streams": [{"values": [["1", "x"]]}]}})[0] is True
        assert scg._dry_run_check("clickhouse", "SELECT 1", 7, lambda args: {"rows": [[1]]})[0] is True


class TestTryGenerateSignal:
    def _stub(self, monkeypatch, *, static_ok=True, dry_ok=True, expr="rate(custom_app_requests_total[5m])"):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(scg, "_generate_expr", lambda kind, schema, invoke=None: expr)
        monkeypatch.setattr(scg, "_static_check", lambda kind, e: static_ok)
        # returns (ok, transient) now — the status API needs to tell a broken attempt from a bad query
        monkeypatch.setattr(scg, "_dry_run_check",
                            lambda kind, e, iid, invoke_connector: (dry_ok, False))

    def test_returns_none_when_disabled(self, monkeypatch):
        monkeypatch.delenv("DIAG_SIGNAL_QUERYGEN_ENABLED", raising=False)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None

    def test_returns_a_ready_generated_row_when_every_check_passes(self, monkeypatch):
        self._stub(monkeypatch)
        row = scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {})
        assert row["status"] == "ready" and row["meta"]["provenance"] == "generated"
        assert row["query"]["tool"] == "prometheus_query"
        assert row["query"]["queries"][0]["expr"] == "rate(custom_app_requests_total[5m])"

    def test_returns_none_when_the_static_check_fails(self, monkeypatch):
        self._stub(monkeypatch, static_ok=False)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None

    def test_returns_none_when_the_dry_run_fails(self, monkeypatch):
        self._stub(monkeypatch, dry_ok=False)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None

    def test_never_raises_when_generation_itself_throws(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        def boom(kind, schema, invoke=None):
            raise RuntimeError("bedrock down")
        monkeypatch.setattr(scg, "_generate_expr", boom)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None


class TestGenerationStatus:
    """The status is what lets datasource_index distinguish "nothing to offer for this schema" (record the
    version, stop rebuilding) from "the attempt broke" (retry next run) — review finding."""

    def test_disabled_when_the_flag_is_off(self, monkeypatch):
        monkeypatch.delenv("DIAG_SIGNAL_QUERYGEN_ENABLED", raising=False)
        row, status = scg.try_generate_signal_with_status("loki", {"labels": ["job"]}, 7, lambda a: {})
        assert row is None and status == scg.DISABLED

    def test_rejected_when_the_static_check_fails(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(scg, "_generate_expr", lambda kind, schema, invoke=None: "DROP TABLE t")
        row, status = scg.try_generate_signal_with_status(
            "clickhouse", {"tables": {"t": ["c"]}}, 7, lambda a: {"rows": [[1]]})
        assert row is None and status == scg.REJECTED

    def test_transient_when_the_dry_run_comes_back_empty(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        row, status = scg.try_generate_signal_with_status(
            "loki", {"labels": ["job"]}, 7, lambda a: {"data": {"streams": []}},
            invoke_llm=lambda prompt: 'count_over_time({job="x"}[5m])')
        assert row is None and status == scg.TRANSIENT

    def test_transient_when_the_connector_throws(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        def boom(args):
            raise RuntimeError("connector down")
        row, status = scg.try_generate_signal_with_status(
            "loki", {"labels": ["job"]}, 7, boom, invoke_llm=lambda prompt: 'count_over_time({job="x"}[5m])')
        assert row is None and status == scg.TRANSIENT

    def test_transient_when_generation_itself_raises(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        def boom_llm(prompt):
            raise RuntimeError("bedrock throttled")
        row, status = scg.try_generate_signal_with_status(
            "loki", {"labels": ["job"]}, 7, lambda a: {"data": {"streams": [1]}}, invoke_llm=boom_llm)
        assert row is None and status == scg.TRANSIENT

    def test_generated_on_success_and_the_wrapper_still_returns_the_row(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        args = ("loki", {"labels": ["job"]}, 7, lambda a: {"data": {"streams": [{"values": [["1", "x"]]}]}})
        kw = {"invoke_llm": lambda prompt: 'count_over_time({job="x"}[5m])'}
        row, status = scg.try_generate_signal_with_status(*args, **kw)
        assert status == scg.GENERATED and row["meta"]["provenance"] == "generated"
        assert scg.try_generate_signal(*args, **kw)["signal_key"] == "generated_signal"


class TestVocabularyGate:
    """A generated query has to be about THIS instance. `SELECT 1` / `vector(1)` passed the static check
    and the dry run — they execute and return a row — and were stored as a ready signal the diagnosis
    report then trusted: a silent misdiagnosis, worse than no signal (review MAJOR)."""

    def test_constant_queries_are_rejected(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        for kind, schema, expr in (
            ("clickhouse", {"tables": {"spans": ["ts"]}}, "SELECT 1"),
            ("prometheus", {"metrics": ["custom_app_requests_total"]}, "vector(1)"),
            ("loki", {"labels": ["job"]}, 'count_over_time({unrelated="x"}[5m])'),
        ):
            monkeypatch.setattr(scg, "_generate_expr", lambda k, s, invoke=None, e=expr: e)
            row, status = scg.try_generate_signal_with_status(
                kind, schema, 7, lambda a: {"rows": [[1]], "data": {"result": [1], "streams": [1]}})
            assert (row, status) == (None, scg.REJECTED), f"{kind} {expr}"

    def test_a_query_naming_a_schema_item_passes(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(scg, "_generate_expr",
                            lambda k, s, invoke=None: "rate(custom_app_requests_total[5m])")
        row, status = scg.try_generate_signal_with_status(
            "prometheus", {"metrics": ["custom_app_requests_total"]}, 7,
            lambda a: {"data": {"result": [{"value": [0, "1"]}]}})
        assert status == scg.GENERATED and row["signal_key"] == "generated_signal"

    def test_no_vocabulary_at_all_cannot_be_anchored(self):
        assert scg._mentions_schema_vocabulary("prometheus", {"metrics": []}, "vector(1)") is False

    # Token match, not substring (second review pass): plain `in` let a constant query match a short or
    # generic name that merely appears inside another word.
    def test_a_short_metric_name_inside_another_word_does_not_count(self):
        assert scg._mentions_schema_vocabulary("prometheus", {"metrics": ["up"]},
                                               "SELECT 1 GROUP BY 1") is False
        assert scg._mentions_schema_vocabulary("prometheus", {"metrics": ["up"]}, "sum(up)") is True

    def test_clickhouse_anchors_on_tables_not_generic_columns(self):
        schema = {"tables": {"spans": ["count", "ts"]}}
        # `count` is a column here, and a constant query mentioning count() is not about this instance
        assert scg._mentions_schema_vocabulary("clickhouse", schema,
                                               "SELECT count() FROM system.tables") is False
        assert scg._mentions_schema_vocabulary("clickhouse", schema,
                                               "SELECT count() FROM spans") is True

    # A query can name a real table and still measure nothing (review, third pass).
    def test_constant_value_with_a_real_table_is_rejected(self, monkeypatch):
        monkeypatch.setenv("DIAG_SIGNAL_QUERYGEN_ENABLED", "true")
        for kind, schema, expr in (
            ("clickhouse", {"tables": {"spans": ["ts"]}}, "SELECT 1 FROM spans"),
            ("clickhouse", {"tables": {"spans": ["ts"]}}, "SELECT 1, 2 FROM spans"),
            ("prometheus", {"metrics": ["up"]}, "vector(1)"),
            ("prometheus", {"metrics": ["up"]}, "scalar( 1.5 )"),
        ):
            monkeypatch.setattr(scg, "_generate_expr", lambda k, sc, invoke=None, e=expr: e)
            row, status = scg.try_generate_signal_with_status(
                kind, schema, 7, lambda a: {"rows": [[1]], "data": {"result": [1]}})
            assert (row, status) == (None, scg.REJECTED), f"{kind} {expr}"

    def test_aggregates_over_a_real_table_are_not_constants(self):
        sch = {"tables": {"spans": ["duration", "ts"]}}
        assert scg._is_constant_expr("clickhouse", sch, "SELECT count() FROM spans") is False
        assert scg._is_constant_expr("clickhouse", sch, "SELECT count(*) FROM spans") is False
        assert scg._is_constant_expr("clickhouse", sch, "SELECT quantile(0.9)(duration) FROM spans") is False
        assert scg._is_constant_expr("clickhouse", sch,
                                     "SELECT avg(duration) FROM spans WHERE ts > now()") is False
        assert scg._is_constant_expr("prometheus", {"metrics": ["up"]}, "rate(up[5m])") is False

    def test_qualified_and_aliased_columns_are_real_queries(self):
        # The value check must not reject ordinary SQL: qualifying a column is how it is normally written,
        # and the first boundary rule ("not preceded by a dot") rejected `s.duration` (review, fifth pass).
        sch = {"tables": {"spans": ["duration", "ts"], "otel.logs": ["body"]}}
        for expr in ("SELECT s.duration FROM spans s",
                     "SELECT quantile(0.9)(s.duration) FROM spans AS s GROUP BY s.ts",
                     "SELECT count() FROM otel.logs"):
            assert scg._is_constant_expr("clickhouse", sch, expr) is False, expr

    def test_the_real_cached_schema_shape_is_understood(self):
        # web/lib/datasource-schema.ts caches tables as a LIST of {name, columns:[{name,type}]} — the
        # shape graph_catalog._clickhouse_trace_spans iterates. The first version of this gate assumed a
        # {table: [cols]} dict, found no table names against a real schema, and rejected EVERY clickhouse
        # query (review, sixth pass).
        real = {"tables": [{"name": "otel.spans",
                            "columns": [{"name": "Duration", "type": "UInt64"},
                                        {"name": "Timestamp", "type": "DateTime"}]}]}
        assert scg._schema_table_names(real) == ["otel.spans", "spans"]   # both spellings
        assert "Duration" in scg._schema_column_names(real)
        assert scg._is_constant_expr("clickhouse", real,
                                     "SELECT quantile(0.9)(Duration) FROM otel.spans") is False
        # the cache may be db-qualified while the query is not, and vice versa
        assert scg._is_constant_expr("clickhouse", real, "SELECT count() FROM spans") is False
        assert scg._is_constant_expr("clickhouse", real, "SELECT 1 AS x FROM otel.spans") is True

    def test_bare_table_name_list_is_also_accepted(self):
        assert scg._schema_table_names({"tables": ["spans"]}) == ["spans"]

    def test_count_over_a_table_outside_the_schema_is_not_a_signal(self):
        # `count()` is allowed as the column-free aggregate, but only over one of THIS instance's tables:
        # counting rows of an unrelated system table measures nothing about the datasource (review).
        sch = {"tables": {"spans": ["duration"]}}
        assert scg._is_constant_expr("clickhouse", sch, "SELECT count() FROM system.tables") is True
        assert scg._is_constant_expr("clickhouse", sch, "SELECT count() FROM spans") is False

    def test_literal_dressed_up_as_a_column_is_still_a_constant(self):
        # "the select list contains a letter" was the first rule and these bypass it trivially
        # (review, fourth pass): the VALUE has to name something from the schema.
        sch = {"tables": {"spans": ["duration", "ts"]}}
        for expr in ("SELECT 1 FROM spans", "SELECT 1 AS x FROM spans", "SELECT toInt8(1) FROM spans",
                     "SELECT 1"):
            assert scg._is_constant_expr("clickhouse", sch, expr) is True, expr

    def test_dotted_names_still_match(self):
        assert scg._mentions_schema_vocabulary("prometheus", {"metrics": ["otel.spans"]},
                                               "rate(otel.spans[5m])") is True


class TestVocabNames:
    def test_dict_shaped_tables_are_supported(self):
        # clickhouse's schema["tables"] is {table: [columns]}; slicing a dict raised TypeError, which the
        # caller turned into TRANSIENT on every run — clickhouse could never generate and retried forever.
        got = scg._vocab_names({"tables": {"spans": ["trace_id", "duration"]}}, "tables")
        assert got[0] == "spans" and "trace_id" in got

    def test_list_shapes_still_work(self):
        assert scg._vocab_names({"metrics": ["up", {"name": "http_requests_total"}]}, "metrics") == \
            ["up", "http_requests_total"]
