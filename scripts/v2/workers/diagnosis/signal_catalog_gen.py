"""Hybrid LLM fallback for signal_catalog.py — invoked by datasource_index.py ONLY when a kind's
deterministic catalog (build_signals) matched zero ready rows, i.e. the instance's schema doesn't
overlap the curated per-kind vocabulary at all (a custom/non-standard instrumentation). Mirrors
graph_querygen.py's pipeline exactly, generalized across query languages (PromQL/LogQL/TraceQL/SQL/
metricSelector) instead of one hardcoded ClickHouse SQL shape.

Gated on DIAG_SIGNAL_QUERYGEN_ENABLED (its own flag, NOT graph_querygen_enabled: "is generation
allowed at all"); never raises; returns None on ANY failure at any stage, so the caller's signal
just stays absent (the deterministic catalog's own `unavailable` rows are the safe fallback).

Validation pipeline (a) static keyword guard (kind-appropriate — only clickhouse's SQL surface has
mutating verbs to reject; other query languages have none, so the check is a structural/blank check
only) and (b) a live dry-run against the connector, asserting a non-error response.
"""
import json
import logging
import os
import re

_FORBIDDEN_SQL_KEYWORDS = (
    "insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "revoke",
    "attach", "detach", "rename", "optimize", "system", "kill", "exchange",
)

_KIND_TOOL = {
    "prometheus": "prometheus_query", "mimir": "mimir_query", "loki": "loki_query_range",
    "tempo": "tempo_search", "jaeger": "jaeger_search", "clickhouse": "clickhouse_query",
    "dynatrace": "dynatrace_query", "datadog": "datadog_query",
}

_VOCAB_KEY = {
    "prometheus": "metrics", "mimir": "metrics", "loki": "labels", "tempo": "tags",
    "jaeger": "services", "clickhouse": "tables", "dynatrace": "metrics", "datadog": "metrics",
}

_QUERY_LANG = {
    "prometheus": "PromQL", "mimir": "PromQL", "loki": "LogQL", "tempo": "TraceQL",
    "jaeger": "a Jaeger search query string", "clickhouse": "a read-only ClickHouse SQL SELECT",
    "dynatrace": "a Dynatrace metricSelector", "datadog": "a Datadog metric query",
}

_PROMPT_TEMPLATE = (
    "You are generating a single {lang} expression for a {kind} datasource, for an ops "
    "diagnostic dashboard. The datasource's schema has these {vocab_key}: {vocab}. Write ONE "
    "expression that surfaces a useful operational signal (error rate, latency, saturation, or "
    "volume) using ONLY names from the list above. Reply with ONLY the expression, no explanation, "
    "no markdown code fences."
)


def _vocab_names(schema, key):
    """Names from the instance's schema for this kind's vocabulary key.

    Handles the DICT shape too: clickhouse's `tables` is {table: [columns]}, and slicing a dict raised
    TypeError — inside the caller's try/except that surfaced as a TRANSIENT generation failure on every
    single run, so clickhouse could never produce a generated signal and retried forever (found while
    fixing the review's unbounded-retry finding). Table names come first, then their columns.
    """
    items = (schema or {}).get(key) or []
    names = []
    if isinstance(items, dict):
        for table, cols in list(items.items())[:40]:
            if isinstance(table, str):
                names.append(table)
            if isinstance(cols, (list, tuple)):
                names.extend(c for c in cols[:20] if isinstance(c, str))
        return names[:60]
    if not isinstance(items, (list, tuple)):
        return names
    for x in items[:40]:
        if isinstance(x, str):
            names.append(x)
        elif isinstance(x, dict) and isinstance(x.get("name"), str):
            names.append(x["name"])
    return names


def _bedrock_invoke(prompt):
    """Default Bedrock invoke — identical model/pattern to graph_querygen._bedrock_invoke."""
    import boto3
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    model = os.environ.get("GRAPH_QUERYGEN_MODEL_ID", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 400,
            "messages": [{"role": "user", "content": prompt}]}
    resp = boto3.client("bedrock-runtime", region_name=region).invoke_model(modelId=model, body=json.dumps(body))
    payload = json.loads(resp["body"].read())
    return "".join(p.get("text", "") for p in payload.get("content", []))


def _generate_expr(kind, schema, invoke=None):
    """Ask the model for one query expression against `schema`'s vocabulary. `invoke` is injectable
    (tests never call Bedrock for real). May raise — the caller wraps this."""
    invoke = invoke or _bedrock_invoke
    vocab_key = _VOCAB_KEY.get(kind, "names")
    vocab = ", ".join(_vocab_names(schema, vocab_key)) or "(none)"
    prompt = _PROMPT_TEMPLATE.format(
        lang=_QUERY_LANG.get(kind, "query"), kind=kind, vocab_key=vocab_key, vocab=vocab)
    text = (invoke(prompt) or "").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        first_line, _, rest = text.partition("\n")
        if rest and re.fullmatch(r"[a-zA-Z]+", first_line.strip()):
            text = rest
    return text.strip()


def _static_check(kind, expr):
    """(a) Structural guard. Pure; never raises."""
    if not isinstance(expr, str) or not expr.strip():
        return False
    if kind == "clickhouse":
        lowered = expr.lower()
        if ";" in expr.rstrip(";"):
            return False
        if not lowered.lstrip().startswith("select"):
            return False
        for kw in _FORBIDDEN_SQL_KEYWORDS:
            if re.search(rf"\b{kw}\b", lowered):
                return False
    return True


def _nonempty_result(kind, result):
    """True only when the connector's payload actually carries data.

    A successful-but-EMPTY response is not evidence the query works: an invented metric name returns
    Prometheus `result: []` with HTTP 200, and the signal would then be stored as a ready chip that is
    permanently empty until the schema drifts (review MAJOR, 2 models). The spec asks for a
    "non-error, non-empty-shape response", so the shape is checked per kind and anything unrecognised
    falls back to "must not be an empty container".
    """
    if isinstance(result, dict):
        data = result.get("data", result)
        if isinstance(data, dict):
            # prometheus/mimir: {"data": {"result": [...]}} — loki shares this shape
            if "result" in data:
                return bool(data.get("result"))
            # loki (streams response) / tempo (traces) / datadog-ish envelopes
            for key in ("streams", "traces", "series", "values", "rows", "data"):
                if key in data:
                    return bool(data.get(key))
            return bool(data)
        return bool(data)
    return bool(result)


# Outcomes, so the caller can tell "this schema has nothing to offer" (worth remembering) from "the
# attempt broke" (worth retrying). datasource_index only records a version sentinel for the former —
# otherwise a Bedrock throttle or a connector outage would be frozen into a permanent skip
# (review: the sentinel turned retryable failures into permanent ones).
DISABLED = "disabled"      # flag off — nothing changes until an operator acts
REJECTED = "rejected"      # the model answered and the answer failed a check: conclusive for this schema
TRANSIENT = "transient"    # something threw: retry next run
GENERATED = "generated"


# A query can name a real table and still measure nothing: `SELECT 1 FROM spans` passes the anchor check
# and the dry run (it returns a row), and `vector(1)` is the PromQL equivalent. These reject the value
# position being a bare literal (review: "the vocabulary gate still accepts constant queries").
#
# This is a lexical floor, NOT a proof of relevance — the same caveat agent/lambda/CLAUDE.md makes about
# keyword denylists applies here: do not grow it until it looks complete. What actually bounds the damage
# is that execution goes through the read-only connector, the row is labelled provenance='generated', and
# a human sees the chip before trusting it.
_CONST_VALUE_FN = re.compile(r"^\s*(?:vector|scalar)\s*\(\s*[-+0-9.eE]+\s*\)\s*$", re.IGNORECASE)
# count() / count(*) are the legitimate column-free aggregates: "how many rows" is a real signal.
_COUNT_ONLY = re.compile(r"\bcount\s*\(\s*\*?\s*\)", re.IGNORECASE)


def _token_present(name, text, allow_dot_prefix=True):
    """`name` appears in `text` as a whole word.

    `allow_dot_prefix=True` (columns) tolerates a qualifier: `SELECT s.duration` must match the column
    `duration`, since qualifying a column is how SQL is normally written, and refusing a preceding dot
    rejected ordinary queries (review, fifth pass).

    `allow_dot_prefix=False` (tables in the FROM) does NOT: a cached `otel.spans` yields the bare segment
    `spans`, and allowing a qualifier there made `FROM other_db.spans` match it — a different table in a
    different database (review, seventh pass). Unqualified `FROM spans` still matches, which is the
    legitimate current-database spelling.
    """
    if not name:
        return False
    left = r"(?<!\w)" if allow_dot_prefix else r"(?<![\w.])"
    return bool(re.search(left + re.escape(name.lower()) + r"(?!\w)", text))


def _sql_tables(schema):
    """[(table, [columns])] from whatever shape `schema["tables"]` is in.

    The REAL cached shape is a LIST of {name, columns:[{name,type}]} — see web/lib/datasource-schema.ts
    and graph_catalog._clickhouse_trace_spans, which iterates exactly that. My first version assumed a
    {table: [cols]} dict, so against a real schema it found no table names at all and the FROM check
    rejected every ClickHouse query (review, sixth pass). Both shapes are accepted now, plus a bare list
    of names, because the tests in this repo use the dict form.
    """
    tables = (schema or {}).get("tables") or []
    out = []
    if isinstance(tables, dict):
        for t, cols in list(tables.items())[:40]:
            if isinstance(t, str):
                out.append((t, [c for c in (cols or []) if isinstance(c, str)][:40]))
        return out
    if not isinstance(tables, (list, tuple)):
        return out
    for t in tables[:40]:
        if isinstance(t, str):
            out.append((t, []))
            continue
        if not isinstance(t, dict):
            continue
        name = t.get("name")
        if not isinstance(name, str):
            continue
        cols = []
        for c in (t.get("columns") or [])[:40]:
            if isinstance(c, str):
                cols.append(c)
            elif isinstance(c, dict) and isinstance(c.get("name"), str):
                cols.append(c["name"])
        out.append((name, cols))
    return out


def _schema_table_names(schema):
    """Table names, plus the last dotted segment: the cache may hold `otel.spans` while the query says
    `FROM spans` (or the reverse), and either spelling refers to the same table."""
    names = []
    for t, _ in _sql_tables(schema):
        names.append(t)
        if "." in t:
            names.append(t.rsplit(".", 1)[-1])
    return names


def _schema_column_names(schema):
    names = []
    for _, cols in _sql_tables(schema):
        names.extend(cols)
    return names


_SQL_AFTER_FROM = re.compile(
    r"\bfrom\b(.*?)(?:\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bhaving\b|$)", re.DOTALL)


def _sql_value_is_measured(schema, expr):
    """For clickhouse: is this query measuring something from THIS instance's schema?

    Two conditions, because each direction was wrong on its own:
      * the FROM must name a schema table — otherwise `SELECT count() FROM system.tables` counted rows
        of an unrelated system table and passed (review, fifth pass);
      * the SELECT list must name a schema column/table, or be `count()` / `count(*)`, the one
        column-free aggregate that is a real signal — otherwise `SELECT 1 AS x FROM spans` passed by
        merely containing a letter (review, fourth pass).
    """
    text = (expr or "").lower()
    sel = re.search(r"\bselect\b(.*?)\bfrom\b", text, re.DOTALL)
    frm = _SQL_AFTER_FROM.search(text)
    if not sel or not frm:
        return False
    tables = _schema_table_names(schema)
    # strict: the FROM must reference one of THIS instance's tables, not a same-named table elsewhere
    if not any(_token_present(t, frm.group(1), allow_dot_prefix=False) for t in tables):
        return False
    select_list = sel.group(1)
    if _COUNT_ONLY.search(select_list):
        return True
    return any(_token_present(n, select_list) for n in tables + _schema_column_names(schema))


def _is_constant_expr(kind, schema, expr):
    """True when the expression's value is a literal, however real the names around it are."""
    text = (expr or "").strip()
    if not text:
        return True
    if kind == "clickhouse":
        return not _sql_value_is_measured(schema, text)
    return bool(_CONST_VALUE_FN.match(text))


def _anchor_names(kind, schema):
    """The names a generated query must reference to count as being about this instance.

    For clickhouse only TABLE names anchor: every SQL query needs a FROM, while column names like
    `count` or `ts` are generic enough that a constant query would match one by accident. For the other
    kinds the vocabulary IS the anchor set (metrics / labels / tags / services).
    """
    if kind == "clickhouse":
        return _schema_table_names(schema)
    return _vocab_names(schema, _VOCAB_KEY.get(kind, "names"))


def _mentions_schema_vocabulary(kind, schema, expr):
    """True when `expr` references at least one name from THIS instance's schema, as a whole token.

    Without this, `SELECT 1` / `vector(1)` passed the static check and the dry run (they execute and
    return a row), so a constant unrelated to the datasource was stored as a ready "AI 생성 신호" and the
    diagnosis report treated it as real — a silent misdiagnosis, worse than no signal (review MAJOR).
    Deterministic catalog rows are vocabulary-checked by signal_catalog._missing_for; generated ones
    bypassed that entirely.

    Token, not substring: plain `in` let `SELECT 1 GROUP BY 1` match a metric named `up` (inside
    "GROUP") and `SELECT count() FROM system.tables` match a column named `count` — both constants with
    nothing to do with the instance (second review pass). The boundary is non-word-and-non-dot so
    `spans` still matches `otel.spans` and `sum(up)` still matches `up`.
    """
    names = _anchor_names(kind, schema)
    if not names:
        return False          # nothing to anchor to → cannot establish relevance
    text = (expr or "").lower()
    return any(_token_present(n, text) for n in names)


def _dry_run_check(kind, expr, integration_id, invoke_connector):
    """(b) Live dry run against the connector. Returns (ok, transient): False on a generic
    error-envelope response or an empty payload (conclusive for this schema — see _nonempty_result),
    and (False, True) when the call itself threw, which is retryable."""
    arg_name = "sql" if kind == "clickhouse" else "query"
    args = {arg_name: expr, "instance_id": integration_id}
    if kind == "clickhouse":
        args["max_rows"] = 1
    try:
        result = invoke_connector(args)
    except Exception:
        return False, True      # connector down / timeout — not a verdict on the query
    if not result:
        return False, True
    if isinstance(result, dict) and "error" in result:
        return False, False       # the connector judged the query: conclusive
    # Empty-but-successful is TRANSIENT, not a verdict: a quiet window (night, low traffic) legitimately
    # returns no samples, and treating that as conclusive froze the instance signal-less until the schema
    # drifted (review MAJOR). The vocabulary check below is what rejects a query that cannot ever match.
    return (True, False) if _nonempty_result(kind, result) else (False, True)


def try_generate_signal(kind, schema, integration_id, invoke_connector, invoke_llm=None):
    """Back-compat wrapper: the row or None. Prefer try_generate_signal_with_status()."""
    return try_generate_signal_with_status(
        kind, schema, integration_id, invoke_connector, invoke_llm)[0]


def try_generate_signal_with_status(kind, schema, integration_id, invoke_connector, invoke_llm=None):
    """Entry point, called from datasource_index.py only when signal_catalog.build_signals matched
    zero ready rows for this kind. Returns (row_or_None, status) where status is one of DISABLED /
    GENERATED / REJECTED / TRANSIENT — never raises.

    The status exists so the caller can decide whether "no signal" is worth remembering. REJECTED
    means the model answered and its answer failed a check, which will repeat for the same schema;
    TRANSIENT means the attempt itself broke and the next run should try again.
    """
    # DIAG_SIGNAL_QUERYGEN_ENABLED, not GRAPH_QUERYGEN_ENABLED: consenting to one ClickHouse graph query
    # is not consenting to daily LLM generation + live dry runs across every fallback-eligible kind
    # (review MAJOR, 4 models across 3 lenses).
    if os.environ.get("DIAG_SIGNAL_QUERYGEN_ENABLED") != "true":
        return None, DISABLED
    try:
        expr = _generate_expr(kind, schema, invoke=invoke_llm)
        if not _static_check(kind, expr):
            return None, REJECTED
        if _is_constant_expr(kind, schema, expr):
            logging.warning("[signal_catalog_gen] generated expr for integration %s measures a constant; "
                            "rejecting", integration_id)
            return None, REJECTED
        if not _mentions_schema_vocabulary(kind, schema, expr):
            logging.warning("[signal_catalog_gen] generated expr for integration %s mentions nothing from "
                            "its schema; rejecting", integration_id)
            return None, REJECTED
        ok, transient = _dry_run_check(kind, expr, integration_id, invoke_connector)
        if not ok:
            return None, (TRANSIENT if transient else REJECTED)
        tool = _KIND_TOOL.get(kind, f"{kind}_query")
        return {
            "signal_key": "generated_signal", "title": "AI 생성 신호", "status": "ready",
            "query": {"tool": tool, "queries": [{"label": "generated", "expr": expr}]},
            "missing_metrics": None,
            "meta": {"kind": kind, "provenance": "generated"},
        }, GENERATED
    except Exception as e:  # noqa: BLE001 — never break the catalog-based rebuild
        logging.warning("[signal_catalog_gen] generation failed for integration %s: %s", integration_id, e)
        return None, TRANSIENT
