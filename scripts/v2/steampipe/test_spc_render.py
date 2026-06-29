"""Unit tests for spc_render.render_spc — pure aws.spc generation for multi-account/region fan-out."""
import os
import sys
import re
import unittest.mock as mock

sys.path.insert(0, os.path.dirname(__file__))
from spc_render import render_spc  # noqa: E402


def _conn_names(spc):
    return re.findall(r'connection\s+"([^"]+)"', spc)


def test_host_only_no_role_arn_no_external_id():
    spc = render_spc([
        {"account_id": "123456789012", "is_host": True, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": True, "regions": []},
    ])
    assert 'connection "aws_123456789012"' in spc
    assert "assume_role_arn" not in spc        # host uses the task role's default chain
    assert "assume_role_external_id" not in spc
    assert 'regions = ["*"]' in spc


def test_non_host_with_external_id():
    spc = render_spc([
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "ext-1", "all_regions": False, "regions": ["us-east-1", "eu-west-1"]},
    ])
    assert 'assume_role_arn = "arn:aws:iam::210987654321:role/AWSopsReadOnlyRole"' in spc
    assert 'assume_role_external_id = "ext-1"' in spc
    assert 'regions = ["us-east-1", "eu-west-1"]' in spc


def test_non_host_without_external_id_omits_line():
    spc = render_spc([
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": True, "regions": []},
    ])
    assert "assume_role_arn" in spc
    assert "assume_role_external_id" not in spc


def test_empty_regions_not_all_is_skipped():
    spc = render_spc([
        {"account_id": "310987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "x", "all_regions": False, "regions": []},
    ])
    assert "aws_310987654321" not in spc   # skipped: not all-regions and nothing enabled


def test_connection_name_is_account_id_and_aggregator_present():
    spc = render_spc([
        {"account_id": "123456789012", "is_host": True, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": True, "regions": []},
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": "ext-1", "all_regions": False, "regions": ["us-east-1"]},
    ])
    assert "aws_123456789012" in _conn_names(spc)
    assert "aws_210987654321" in _conn_names(spc)
    # aggregator spans all per-account connections so existing `aws.*` queries fan out
    assert 'connection "aws"' in spc
    assert 'type = "aggregator"' in spc
    assert 'connections = ["aws_*"]' in spc


def test_hcl_escaping_of_values():
    spc = render_spc([
        {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
         "external_id": 'a"b\\c', "all_regions": False, "regions": ["us-east-1"]},
    ])
    assert 'assume_role_external_id = "a\\"b\\\\c"' in spc


def test_host_included_even_when_flag_false_and_no_regions():
    # C1 regression guard: ensureHostRow may seed the host without account_regions; the host must
    # still scan all regions (not be skipped), else the whole inventory empties.
    spc = render_spc([
        {"account_id": "123456789012", "is_host": True, "role_name": "AWSopsReadOnlyRole",
         "external_id": None, "all_regions": False, "regions": []},
    ])
    assert 'connection "aws_123456789012"' in spc
    assert 'regions = ["*"]' in spc


# --- Supervisor / blast-radius tests (gen_spc_entrypoint) ---
import gen_spc_entrypoint  # noqa: E402


def test_steampipe_env_strips_aurora_secret():
    """AURORA_SECRET must NOT appear in the env passed to the Steampipe subprocess (M1/M2).
    Steampipe is the network-listening process — it must never hold master DB credentials.
    AURORA_SECRET is also popped from os.environ at module startup; this test verifies that
    _steampipe_env() strips it even if it somehow re-appears in the process environment."""
    with mock.patch.dict(os.environ, {
        "AURORA_SECRET": '{"username":"u","password":"p"}',
        "AURORA_ENDPOINT": "aurora.host",
        "AURORA_DATABASE": "awsops",
    }):
        env = gen_spc_entrypoint._steampipe_env()
    assert "AURORA_SECRET" not in env, "master DB creds must not reach the Steampipe subprocess"
    assert "AURORA_ENDPOINT" in env  # non-sensitive env is forwarded normally


def test_aurora_secret_removed_from_process_env():
    """AURORA_SECRET must be removed from the process environment at module load (M2 blast-radius).
    If the Steampipe subprocess is compromised, /proc/1/environ must not expose master creds."""
    # The module pops AURORA_SECRET from os.environ at import time; it should not be present now.
    assert "AURORA_SECRET" not in os.environ, (
        "AURORA_SECRET must be popped from process env at startup — "
        "do not leave master DB creds visible in /proc/1/environ"
    )


def test_steampipe_env_forwards_non_sensitive_vars():
    """Non-sensitive env vars (AURORA_ENDPOINT, AURORA_DATABASE, AWS_REGION) are forwarded."""
    with mock.patch.dict(os.environ, {
        "AURORA_SECRET": '{"username":"u","password":"p"}',
        "AURORA_ENDPOINT": "aurora.cluster.example.com",
        "AURORA_DATABASE": "awsops",
        "AWS_REGION": "ap-northeast-2",
    }):
        env = gen_spc_entrypoint._steampipe_env()
    assert env["AURORA_ENDPOINT"] == "aurora.cluster.example.com"
    assert env["AWS_REGION"] == "ap-northeast-2"
    assert "AURORA_SECRET" not in env
