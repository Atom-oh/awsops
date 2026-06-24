"""Unit tests for agent/anthropic_loop.py — pure helpers + the injected agentic loop.

Stdlib unittest only. anthropic_loop's module top-level is stdlib-only (the heavy
imports — agent, anthropic — are lazy inside run_anthropic_loop), so the pure helpers
and the injected loop are testable here with NO anthropic/strands/network.

Run:  cd agent && python3 -m unittest tests.test_anthropic_loop
"""
import asyncio
import os
import types
import unittest

import anthropic_loop as al


# ── Fakes ────────────────────────────────────────────────────────────────────
class FakeTool:
    """Mimics a Strands MCP tool: .tool_name + .tool_spec (inputSchema wrapped in {'json': …})."""
    def __init__(self, name, description="", input_schema=None, nested=True):
        self.tool_name = name
        self.description = description
        schema = input_schema if input_schema is not None else {"type": "object", "properties": {}}
        self.tool_spec = {
            "name": name,
            "description": description,
            "inputSchema": {"json": schema} if nested else schema,
        }


def run(agen):
    """Drain an async generator to a list (sync test helper)."""
    async def _collect():
        return [x async for x in agen]
    return asyncio.run(_collect())


# ── should_use_anthropic_loop (truth table) ──────────────────────────────────
class ShouldUseAnthropicLoopTest(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get("ANTHROPIC_AGENT_LOOP_ENABLED")
        os.environ.pop("ANTHROPIC_AGENT_LOOP_ENABLED", None)

    def tearDown(self):
        os.environ.pop("ANTHROPIC_AGENT_LOOP_ENABLED", None)
        if self._saved is not None:
            os.environ["ANTHROPIC_AGENT_LOOP_ENABLED"] = self._saved

    def test_env_unset_no_override_is_false(self):
        self.assertFalse(al.should_use_anthropic_loop({}))

    def test_env_true_no_override_is_true(self):
        os.environ["ANTHROPIC_AGENT_LOOP_ENABLED"] = "true"
        self.assertTrue(al.should_use_anthropic_loop({}))

    def test_env_true_but_payload_strands_overrides_false(self):
        os.environ["ANTHROPIC_AGENT_LOOP_ENABLED"] = "true"
        self.assertFalse(al.should_use_anthropic_loop({"agentLoop": "strands"}))

    def test_env_unset_but_payload_anthropic_overrides_true(self):
        self.assertTrue(al.should_use_anthropic_loop({"agentLoop": "anthropic"}))

    def test_env_garbage_is_false(self):
        os.environ["ANTHROPIC_AGENT_LOOP_ENABLED"] = "yes-please"
        self.assertFalse(al.should_use_anthropic_loop({}))

    def test_none_payload_safe(self):
        self.assertFalse(al.should_use_anthropic_loop(None))


# ── mcp_tools_to_anthropic ────────────────────────────────────────────────────
class McpToolsToAnthropicTest(unittest.TestCase):
    def test_maps_name_description_and_unwraps_nested_schema(self):
        schema = {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]}
        out = al.mcp_tools_to_anthropic([FakeTool("get_x", "Get the X. Detail.", schema)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["name"], "get_x")
        self.assertEqual(out[0]["description"], "Get the X. Detail.")
        # nested {'json': schema} must be unwrapped to the bare JSON Schema
        self.assertEqual(out[0]["input_schema"], schema)

    def test_flat_schema_passthrough(self):
        schema = {"type": "object", "properties": {"y": {"type": "number"}}}
        out = al.mcp_tools_to_anthropic([FakeTool("f", "d", schema, nested=False)])
        self.assertEqual(out[0]["input_schema"], schema)

    def test_missing_or_empty_schema_defaults_to_object(self):
        out = al.mcp_tools_to_anthropic([FakeTool("g", "d", {})])
        self.assertEqual(out[0]["input_schema"], {"type": "object", "properties": {}})

    def test_preserves_order(self):
        out = al.mcp_tools_to_anthropic([FakeTool("a"), FakeTool("b"), FakeTool("c")])
        self.assertEqual([t["name"] for t in out], ["a", "b", "c"])


# ── build_anthropic_messages ─────────────────────────────────────────────────
class BuildAnthropicMessagesTest(unittest.TestCase):
    def test_history_plus_last_user_input(self):
        history = [
            {"role": "user", "content": [{"text": "hi"}]},
            {"role": "assistant", "content": [{"text": "hello"}]},
        ]
        msgs = al.build_anthropic_messages(history, "what is up?")
        self.assertEqual(msgs[0], {"role": "user", "content": [{"type": "text", "text": "hi"}]})
        self.assertEqual(msgs[1], {"role": "assistant", "content": [{"type": "text", "text": "hello"}]})
        self.assertEqual(msgs[-1], {"role": "user", "content": [{"type": "text", "text": "what is up?"}]})

    def test_empty_history(self):
        msgs = al.build_anthropic_messages([], "only message")
        self.assertEqual(msgs, [{"role": "user", "content": [{"type": "text", "text": "only message"}]}])


# ── extract_tool_uses (dict AND object blocks) ───────────────────────────────
class ExtractToolUsesTest(unittest.TestCase):
    def test_dict_blocks(self):
        blocks = [
            {"type": "text", "text": "thinking"},
            {"type": "tool_use", "id": "tu_1", "name": "list_vpcs", "input": {"region": "x"}},
        ]
        uses = al.extract_tool_uses(blocks)
        self.assertEqual(uses, [{"id": "tu_1", "name": "list_vpcs", "input": {"region": "x"}}])

    def test_object_blocks_like_real_sdk(self):
        text = types.SimpleNamespace(type="text", text="hi")
        tu = types.SimpleNamespace(type="tool_use", id="tu_2", name="get_topology", input={})
        uses = al.extract_tool_uses([text, tu])
        self.assertEqual(uses, [{"id": "tu_2", "name": "get_topology", "input": {}}])

    def test_no_tool_use_returns_empty(self):
        self.assertEqual(al.extract_tool_uses([{"type": "text", "text": "x"}]), [])


# ── tool_result_block ─────────────────────────────────────────────────────────
class ToolResultBlockTest(unittest.TestCase):
    def test_shape(self):
        b = al.tool_result_block("tu_1", "some result")
        self.assertEqual(b["type"], "tool_result")
        self.assertEqual(b["tool_use_id"], "tu_1")
        self.assertEqual(b["content"], [{"type": "text", "text": "some result"}])
        self.assertNotIn("is_error", b)  # only present when True

    def test_error_flag(self):
        b = al.tool_result_block("tu_2", "boom", is_error=True)
        self.assertTrue(b["is_error"])


# ── apply_cache_control ───────────────────────────────────────────────────────
class ApplyCacheControlTest(unittest.TestCase):
    def test_marks_last_system_and_last_tool(self):
        sys_blocks = [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]
        tools = [{"name": "t1"}, {"name": "t2"}]
        al.apply_cache_control(sys_blocks, tools)
        self.assertNotIn("cache_control", sys_blocks[0])
        self.assertEqual(sys_blocks[-1]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(tools[-1]["cache_control"], {"type": "ephemeral"})

    def test_empty_lists_no_crash(self):
        al.apply_cache_control([], [])  # must not raise


if __name__ == "__main__":
    unittest.main()
