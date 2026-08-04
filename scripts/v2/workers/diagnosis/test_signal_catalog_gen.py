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

    def test_fails_on_a_falsy_response(self):
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: None) == (False, False)

    # A 200 carrying no rows is not evidence the query works: an invented metric name returns
    # `result: []`, and the signal would be stored as a ready chip that stays permanently empty
    # (review MAJOR, 2 models). The spec asks for a non-error, NON-EMPTY-shape response.
    def test_fails_on_an_empty_prometheus_result(self):
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"data": {"result": []}})[0] is False
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"result": []})[0] is False

    def test_fails_on_empty_loki_streams_and_tempo_traces(self):
        assert scg._dry_run_check("loki", '{job=~".+"}', 7, lambda args: {"data": {"streams": []}})[0] is False
        assert scg._dry_run_check("tempo", "{}", 7, lambda args: {"data": {"traces": []}})[0] is False

    def test_fails_on_an_empty_envelope_of_any_shape(self):
        assert scg._dry_run_check("clickhouse", "SELECT 1", 7, lambda args: {})[0] is False
        assert scg._dry_run_check("clickhouse", "SELECT 1", 7, lambda args: {"rows": []})[0] is False
        assert scg._dry_run_check("clickhouse", "SELECT 1", 7, lambda args: [])[0] is False

    def test_passes_when_rows_are_actually_present(self):
        assert scg._dry_run_check("prometheus", "up", 7,
                                  lambda args: {"data": {"result": [{"value": [0, "1"]}]}})[0] is True
        assert scg._dry_run_check("loki", '{job=~".+"}', 7,
                                  lambda args: {"data": {"streams": [{"values": [["1", "x"]]}]}})[0] is True
        assert scg._dry_run_check("clickhouse", "SELECT 1", 7, lambda args: {"rows": [[1]]})[0] is True


class TestTryGenerateSignal:
    def _stub(self, monkeypatch, *, static_ok=True, dry_ok=True, expr="rate(custom_app_requests_total[5m])"):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(scg, "_generate_expr", lambda kind, schema, invoke=None: expr)
        monkeypatch.setattr(scg, "_static_check", lambda kind, e: static_ok)
        # returns (ok, transient) now — the status API needs to tell a broken attempt from a bad query
        monkeypatch.setattr(scg, "_dry_run_check",
                            lambda kind, e, iid, invoke_connector: (dry_ok, False))

    def test_returns_none_when_disabled(self, monkeypatch):
        monkeypatch.delenv("GRAPH_QUERYGEN_ENABLED", raising=False)
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
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        def boom(kind, schema, invoke=None):
            raise RuntimeError("bedrock down")
        monkeypatch.setattr(scg, "_generate_expr", boom)
        assert scg.try_generate_signal("prometheus", SCHEMA, 7, lambda a: {}) is None


class TestGenerationStatus:
    """The status is what lets datasource_index distinguish "nothing to offer for this schema" (record the
    version, stop rebuilding) from "the attempt broke" (retry next run) — review finding."""

    def test_disabled_when_the_flag_is_off(self, monkeypatch):
        monkeypatch.delenv("GRAPH_QUERYGEN_ENABLED", raising=False)
        row, status = scg.try_generate_signal_with_status("loki", {"labels": ["job"]}, 7, lambda a: {})
        assert row is None and status == scg.DISABLED

    def test_rejected_when_the_static_check_fails(self, monkeypatch):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(scg, "_generate_expr", lambda kind, schema, invoke=None: "DROP TABLE t")
        row, status = scg.try_generate_signal_with_status(
            "clickhouse", {"tables": {"t": ["c"]}}, 7, lambda a: {"rows": [[1]]})
        assert row is None and status == scg.REJECTED

    def test_rejected_when_the_dry_run_comes_back_empty(self, monkeypatch):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        row, status = scg.try_generate_signal_with_status(
            "loki", {"labels": ["job"]}, 7, lambda a: {"data": {"streams": []}},
            invoke_llm=lambda prompt: 'count_over_time({job="x"}[5m])')
        assert row is None and status == scg.REJECTED

    def test_transient_when_the_connector_throws(self, monkeypatch):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        def boom(args):
            raise RuntimeError("connector down")
        row, status = scg.try_generate_signal_with_status(
            "loki", {"labels": ["job"]}, 7, boom, invoke_llm=lambda prompt: 'count_over_time({job="x"}[5m])')
        assert row is None and status == scg.TRANSIENT

    def test_transient_when_generation_itself_raises(self, monkeypatch):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        def boom_llm(prompt):
            raise RuntimeError("bedrock throttled")
        row, status = scg.try_generate_signal_with_status(
            "loki", {"labels": ["job"]}, 7, lambda a: {"data": {"streams": [1]}}, invoke_llm=boom_llm)
        assert row is None and status == scg.TRANSIENT

    def test_generated_on_success_and_the_wrapper_still_returns_the_row(self, monkeypatch):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        args = ("loki", {"labels": ["job"]}, 7, lambda a: {"data": {"streams": [{"values": [["1", "x"]]}]}})
        kw = {"invoke_llm": lambda prompt: 'count_over_time({job="x"}[5m])'}
        row, status = scg.try_generate_signal_with_status(*args, **kw)
        assert status == scg.GENERATED and row["meta"]["provenance"] == "generated"
        assert scg.try_generate_signal(*args, **kw)["signal_key"] == "generated_signal"
