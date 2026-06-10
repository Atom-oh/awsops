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
