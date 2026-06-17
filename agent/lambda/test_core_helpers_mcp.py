"""Tests for core_helpers_mcp — static prompt_understanding + suggest_aws_commands (NO call_aws)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import core_helpers_mcp as ch  # noqa: E402


class TestPromptUnderstanding(unittest.TestCase):
    def test_returns_static_guide(self):
        out = ch.lambda_handler({"tool_name": "prompt_understanding"}, None)
        self.assertEqual(out["statusCode"], 200)
        self.assertIn("AWS Solution Design Guide", out["body"])

    def test_guide_does_not_advertise_call_aws_or_steampipe(self):
        # read-only variant: must not advertise the mutating/steampipe escape hatches
        out = ch.lambda_handler({"tool_name": "prompt_understanding"}, None)
        self.assertNotIn("call_aws", out["body"])
        self.assertNotIn("run_steampipe_query", out["body"])


class TestSuggest(unittest.TestCase):
    def test_suggests_for_query(self):
        out = ch.lambda_handler({"tool_name": "suggest_aws_commands", "arguments": {"query": "list ec2 instances"}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = json.loads(out["body"])
        self.assertIn("aws ec2 describe-instances", body["suggestions"])

    def test_target_account_id_popped(self):
        out = ch.lambda_handler(
            {"tool_name": "suggest_aws_commands", "arguments": {"query": "ec2", "target_account_id": "123456789012"}},
            None,
        )
        self.assertEqual(out["statusCode"], 200)


class TestNoCallAws(unittest.TestCase):
    def test_call_aws_is_not_a_tool(self):
        # the escape hatch is ABSENT — call_aws must be rejected as unknown
        out = ch.lambda_handler({"tool_name": "call_aws", "arguments": {"cli_command": "aws ec2 describe-instances"}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_no_call_aws_symbol_in_module(self):
        self.assertFalse(hasattr(ch, "call_aws"), "core-helpers must not define call_aws")

    def test_unknown_tool(self):
        out = ch.lambda_handler({"tool_name": "frobnicate"}, None)
        self.assertEqual(out["statusCode"], 400)


if __name__ == "__main__":
    unittest.main()
