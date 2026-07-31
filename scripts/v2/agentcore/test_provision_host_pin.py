"""Per-preset host pin (ADR-017 deviation ② closed).

Without this pin `official_mcp_endpoints` only had to be https:// and the ack was a self-echo of the
operator's own string, so a preset key could be bound to any host and _ensure_api_key_provider would
hand that host the preset's real vendor credential — effectively the BYO-MCP connection BASELINE §2
pins as do-not-revive. These tests fix the two bypass shapes that a naive raw-URL `endswith` lets
through, and assert a catalog entry declaring neither state fails closed rather than defaulting open.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import catalog  # noqa: E402
import provision  # noqa: E402


def _spec(preset_key):
    for v in catalog.MCP_SERVER_TARGETS.values():
        if v["preset_key"] == preset_key:
            return v
    raise AssertionError(f"no preset {preset_key!r} in catalog")


class TestEveryPresetIsClassified(unittest.TestCase):
    def test_no_preset_is_left_unclassified(self):
        # A preset with neither key would fail closed at runtime, i.e. be silently unusable — catch
        # that here instead, at the point someone adds a preset.
        for name, spec in catalog.MCP_SERVER_TARGETS.items():
            pinned = bool(spec.get("allowed_host_suffixes"))
            asserted = bool(spec.get("host_is_operator_asserted"))
            self.assertTrue(
                pinned ^ asserted,
                f"{name}: exactly one of allowed_host_suffixes / host_is_operator_asserted required "
                f"(pinned={pinned}, operator_asserted={asserted})",
            )


class TestHostPin(unittest.TestCase):
    def test_vendor_host_and_regional_sibling_allowed(self):
        dd = _spec("datadog")
        self.assertIsNone(provision._host_pin_violation("https://mcp.datadoghq.com/mcp", dd))
        self.assertIsNone(provision._host_pin_violation("https://mcp.datadoghq.eu/mcp", dd))

    def test_trailing_dot_is_normalised(self):
        self.assertIsNone(
            provision._host_pin_violation("https://mcp.datadoghq.com./mcp", _spec("datadog"))
        )

    def test_missing_dot_boundary_is_rejected(self):
        # `endswith("datadoghq.com")` on the raw URL would ALLOW this.
        self.assertIsNotNone(
            provision._host_pin_violation("https://evil-datadoghq.com/mcp", _spec("datadog"))
        )

    def test_allowed_suffix_in_the_middle_is_rejected(self):
        self.assertIsNotNone(
            provision._host_pin_violation(
                "https://datadoghq.com.attacker.example/mcp", _spec("datadog")
            )
        )

    def test_unrelated_host_is_rejected(self):
        self.assertIsNotNone(
            provision._host_pin_violation("https://attacker.example/mcp", _spec("datadog"))
        )

    def test_self_hosted_preset_accepts_an_operator_host(self):
        self.assertIsNone(
            provision._host_pin_violation("https://clickhouse.internal:8123/mcp", _spec("clickhouse"))
        )

    def test_catalog_entry_declaring_neither_fails_closed(self):
        self.assertIsNotNone(provision._host_pin_violation("https://anything.example/", {}))
