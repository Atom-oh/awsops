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
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"result": {"shape": "vector"}}) is True

    def test_fails_on_a_connector_exception(self):
        def boom(args):
            raise RuntimeError("down")
        assert scg._dry_run_check("prometheus", "up", 7, boom) is False

    def test_fails_on_an_error_envelope_response(self):
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: {"error": "no such metric"}) is False

    def test_fails_on_a_falsy_response(self):
        assert scg._dry_run_check("prometheus", "up", 7, lambda args: None) is False


class TestTryGenerateSignal:
    def _stub(self, monkeypatch, *, static_ok=True, dry_ok=True, expr="rate(custom_app_requests_total[5m])"):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(scg, "_generate_expr", lambda kind, schema, invoke=None: expr)
        monkeypatch.setattr(scg, "_static_check", lambda kind, e: static_ok)
        monkeypatch.setattr(scg, "_dry_run_check", lambda kind, e, iid, invoke_connector: dry_ok)

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
