# scripts/v2/remediation/test_remediation.py
"""ADR-029+036 remediation substrate tests — catalog loader + fail-closed gating (Task 3).
No live AWS / no DB: a fake conn and a monkeypatched SSM client exercise every gate branch."""
import ast
import os
import pathlib
import sys

_HERE = pathlib.Path(__file__).resolve().parent
# action_catalog.py does `import db` (scripts/v2/workers/db.py, shipped in the same artifact).
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent / "workers"))
os.environ.setdefault("AWS_REGION", "ap-northeast-2")

import action_catalog as ac  # noqa: E402


_ACTION_ROW = (
    "ec2-detach-sg",          # name
    "ssm",                    # executor_type
    "ec2:instance",           # target_resource_type
    "RemediationAutomationRole",  # assume_role_ref
    '["resourceArn"]',        # required_inputs (JSON text — loader must parse)
    '{"mode":"describe"}',    # dry_run_contract (JSON text)
    "onFailure-reattach",     # rollback_ref
    "four_eyes",              # approval_mode
    '{"accounts":["self"]}',  # conditions (JSON text)
    True,                     # enabled
)


class _FakeConn:
    """Minimal pg8000-shaped conn: .run(sql, **params) -> list-of-row-tuples."""

    def __init__(self, rows):
        self._rows = rows
        self.calls = []

    def run(self, sql, **params):
        self.calls.append((sql, params))
        return self._rows


class _FakeParam:
    def __init__(self, value):
        self._value = value

    def get_parameter(self, Name):  # noqa: N803 (mirror boto3 signature)
        return {"Parameter": {"Value": self._value}}


def test_module_compiles():
    src = (_HERE / "action_catalog.py").read_text()
    ast.parse(src)  # raises SyntaxError on a broken module


def test_load_action_parses_json_columns():
    conn = _FakeConn([_ACTION_ROW])
    a = ac.load_action(conn, "ec2-detach-sg")
    assert a["name"] == "ec2-detach-sg"
    assert a["enabled"] is True
    # JSON text columns must be decoded to native structures.
    assert a["required_inputs"] == ["resourceArn"]
    assert a["dry_run_contract"] == {"mode": "describe"}
    assert a["conditions"] == {"accounts": ["self"]}


def test_load_action_missing_returns_none():
    assert ac.load_action(_FakeConn([]), "nope") is None


def test_gate_flag_off_when_env_unset(monkeypatch):
    monkeypatch.delenv("REMEDIATION_ENABLED", raising=False)
    # SSM on + enabled row would otherwise pass — flag must short-circuit first.
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert a is None and reason == "flag_off"


def test_gate_killswitch_off_when_param_false(monkeypatch):
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _FakeParam("false"))
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert a is None and reason == "killswitch_off"


def test_gate_killswitch_fail_closed_on_ssm_error(monkeypatch):
    class _Boom:
        def get_parameter(self, Name):  # noqa: N803
            raise RuntimeError("ssm unreachable")

    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _Boom())
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert a is None and reason == "killswitch_off"


def test_gate_unknown_action(monkeypatch):
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([]), "ghost")
    assert a is None and reason == "unknown_action"


def test_gate_action_disabled_row(monkeypatch):
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    disabled = _ACTION_ROW[:-1] + (False,)
    a, reason = ac.gate(_FakeConn([disabled]), "ec2-detach-sg")
    assert a is None and reason == "action_disabled"


def test_gate_passes_only_when_all_three_pass(monkeypatch):
    monkeypatch.setenv("REMEDIATION_ENABLED", "true")
    monkeypatch.setattr(ac, "_ssm", _FakeParam("true"))
    a, reason = ac.gate(_FakeConn([_ACTION_ROW]), "ec2-detach-sg")
    assert reason is None
    assert a is not None and a["name"] == "ec2-detach-sg"


# ---------------------------------------------------------------------------
# Task 4: remediation_executor.py — dry-run / execute / rollback skeleton.
# No live AWS / no DB: monkeypatch db.connect, cat.gate, _assume.
# ---------------------------------------------------------------------------
import remediation_executor as ex  # noqa: E402


class _ExecConn:
    """Records every .run() and .close() so we can assert NO terminal write happened."""

    def __init__(self):
        self.calls = []
        self.closed = False

    def run(self, sql, **params):
        self.calls.append((sql, params))
        return []

    def close(self):
        self.closed = True


def _boom_assume(*_a, **_k):  # pragma: no cover - must never be reached on a blocked path
    raise AssertionError("_assume must not be called when the action is gate-blocked")


def test_executor_module_compiles():
    src = (_HERE / "remediation_executor.py").read_text()
    ast.parse(src)  # raises SyntaxError on a broken module


def test_dry_run_fns_are_pure_and_declare_no_mutation():
    # A poisoned session: any boto3 attribute access raises — proves dry-run never touches AWS.
    class _PoisonSession:
        def __getattr__(self, _name):
            raise AssertionError("dry-run must not touch boto3 / the session")

    sess = _PoisonSession()
    flag = ex._flag_dry_run({"flagKey": "beta", "value": True}, sess)
    assert flag["mutates"] is False and flag["would_set"] == "beta"
    ops = ex._opsitem_dry_run({"title": "investigate"}, sess)
    assert ops["mutates"] is False and ops["would_create_opsitem_title"] == "investigate"


def test_handler_gate_blocked_fails_closed_no_terminal_write(monkeypatch):
    conn = _ExecConn()
    monkeypatch.setattr(ex.db, "connect", lambda: conn)
    monkeypatch.setattr(ex.cat, "gate", lambda _c, _n: (None, "killswitch_off"))
    # If the role were ever assumed on a blocked path that is a safety violation.
    monkeypatch.setattr(ex, "_assume", _boom_assume)

    import pytest  # noqa: E402

    with pytest.raises(RuntimeError, match="^blocked:killswitch_off$"):
        ex.lambda_handler(
            {"job_id": "j1", "action": "app-feature-flag-set", "phase": "execute"}, None)
    # Fail-closed: no UPDATE/INSERT at all → no terminal status written.
    assert conn.calls == []
    assert conn.closed is True  # finally: conn.close() still ran


def test_handler_rollback_without_handler_raises_manual(monkeypatch):
    conn = _ExecConn()
    monkeypatch.setattr(ex.db, "connect", lambda: conn)
    # opscenter-create-opsitem has rb=None; gate must pass for us to reach the rollback branch.
    monkeypatch.setattr(ex.cat, "gate", lambda _c, _n: ({"name": "opscenter-create-opsitem"}, None))
    monkeypatch.setattr(ex, "_assume", lambda _arn: object())
    monkeypatch.setenv("ACTION_ROLE_OPSCENTER_CREATE_OPSITEM", "arn:aws:iam::1:role/x")

    import pytest  # noqa: E402

    with pytest.raises(RuntimeError, match="MANUAL_INTERVENTION_REQUIRED"):
        ex.lambda_handler(
            {"job_id": "j2", "action": "opscenter-create-opsitem", "phase": "rollback"}, None)
    assert conn.closed is True
