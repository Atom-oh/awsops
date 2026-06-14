"""Tests for agent.py account normalization (effective_account_id / _host_account_id).

agent.py imports runtime-only deps (strands, bedrock_agentcore) and runs AWS calls
at import time, so we exec just the two pure functions from source rather than
importing the whole module.

Regression: a chat targeting the host account injected target_account_id=<host>,
which made the tool layer self-assume the nonexistent host-account AWSopsReadOnlyRole.
effective_account_id() blanks the host account so the directive is never emitted.
"""
import os

import pytest

_AGENT = os.path.join(os.path.dirname(__file__), "agent.py")
HOST = "180294183052"


def _load_funcs():
    """Exec just the _host_account_id..effective_account_id block from agent.py."""
    with open(_AGENT, encoding="utf-8") as fh:
        src = fh.read()
    start = src.index("@functools.lru_cache(maxsize=1)")
    end = src.index("def build_account_directive(")
    block = src[start:end]
    import functools
    import boto3
    ns = {"functools": functools, "os": os, "boto3": boto3}
    exec(compile(block, _AGENT, "exec"), ns)  # noqa: S102 - trusted local source
    return ns


@pytest.fixture
def funcs(monkeypatch):
    # Pin host via env so _host_account_id makes no STS call.
    monkeypatch.setenv("AWSOPS_HOST_ACCOUNT_ID", HOST)
    return _load_funcs()


def test_host_account_blanked(funcs):
    # host account → '' (same-account: use the agent's own role, no directive)
    assert funcs["effective_account_id"](HOST) == ""
    assert funcs["effective_account_id"](f"  {HOST}  ") == ""


def test_other_account_passthrough(funcs):
    assert funcs["effective_account_id"]("222222222222") == "222222222222"


def test_all_and_empty_blanked(funcs):
    assert funcs["effective_account_id"]("__all__") == ""
    assert funcs["effective_account_id"]("") == ""
    assert funcs["effective_account_id"](None) == ""
