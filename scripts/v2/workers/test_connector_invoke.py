"""connector_invoke: credential-blind invoke + non-PII summarize (extracted from diagnosis/sources)."""
import json

import connector_invoke as ci


class _FakePayload:
    def __init__(self, b):
        self._b = b

    def read(self):
        return self._b


class _FakeLambda:
    def __init__(self, status=200, body=None):
        self.last = None
        self._resp = json.dumps({"statusCode": status, "body": json.dumps(body or {})}).encode()

    def invoke(self, **kw):
        self.last = kw
        return {"Payload": _FakePayload(self._resp)}


def test_invoke_is_credential_blind_and_resolves_name(monkeypatch):
    fake = _FakeLambda(200, {"resultType": "vector", "result": [{"metric": {"job": "x"}}]})
    monkeypatch.setattr(ci, "_lambda_client", lambda: fake)
    status, body = ci.invoke_connector("prometheus", "prometheus_query", "inst-1", {"query": "up"})
    assert status == 200
    assert isinstance(body, dict)
    assert fake.last["FunctionName"] == f"{ci.PROJECT}-agent-prometheus-mcp"
    sent = json.loads(fake.last["Payload"].decode())
    assert sent == {"tool_name": "prometheus_query", "arguments": {"query": "up", "instance_id": "inst-1"}}
    blob = json.dumps(sent)
    for k in ("conn_config", "credentials", "password", "token", "username", "endpoint"):
        assert k not in blob  # credential-blind: never sent


def test_summarize_is_signal_only_no_raw_values():
    body = {"resultType": "streams",
            "result": [{"metric": {"app": "mall", "pod": "p1"}, "values": [["t", "SECRET LOG LINE"]]}]}
    s = ci.summarize_result(body)
    assert s["count"] == 1
    assert s["source"] == "result"
    assert set(s["labels"]) == {"app", "pod"}            # LABEL NAMES only
    assert "SECRET LOG LINE" not in json.dumps(s)        # NO raw sample values
    assert s["resultType"] == "streams"


def test_summarize_handles_nondict_and_traces():
    assert ci.summarize_result(None) == {}
    s = ci.summarize_result({"traces": [1, 2, 3]})
    assert s["count"] == 3 and s["source"] == "traces"


class _RawLambda:
    """Returns an arbitrary invoke() response (incl. FunctionError / missing statusCode)."""
    def __init__(self, resp):
        self._resp = resp

    def invoke(self, **kw):
        out = dict(self._resp)
        out["Payload"] = _FakePayload(out.get("Payload", b""))
        return out


def test_function_error_is_a_failure_not_zero(monkeypatch):
    # A Lambda FunctionError means the tool did NOT run. It must map to a failing status (>=400),
    # never to 0 (which both callers read as success: `status >= 400` False / `status and ...` falsy).
    fake = _RawLambda({"FunctionError": "Unhandled",
                       "Payload": json.dumps({"errorMessage": "boom"}).encode()})
    monkeypatch.setattr(ci, "_lambda_client", lambda: fake)
    status, body = ci.invoke_connector("loki", "loki_query_range", "i", {"query": "x"})
    assert status >= 400 and isinstance(body, dict)


def test_missing_statuscode_is_a_failure(monkeypatch):
    # A malformed envelope with no statusCode previously defaulted to 0 (read as success). Treat
    # missing/non-int statusCode as a failure so the >=400 gate catches it.
    fake = _RawLambda({"Payload": json.dumps({"body": json.dumps({"result": []})}).encode()})
    monkeypatch.setattr(ci, "_lambda_client", lambda: fake)
    status, _body = ci.invoke_connector("prometheus", "prometheus_query", "i", {"query": "up"})
    assert status >= 400


def test_str_body_is_json_parsed(monkeypatch):
    # body delivered as a JSON string is parsed to a dict (connector envelope shape)
    fake = _FakeLambda(200, {"result": []})
    monkeypatch.setattr(ci, "_lambda_client", lambda: fake)
    _status, body = ci.invoke_connector("loki", "loki_query_range", "i", {"query": "x"})
    assert isinstance(body, dict) and body.get("result") == []
