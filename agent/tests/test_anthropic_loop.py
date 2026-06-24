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


# ── Fakes for the injected agentic loop (Task 2) ─────────────────────────────
class _FakeStreamCtx:
    def __init__(self, chunks, final):
        self._chunks, self._final = chunks, final

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    @property
    def text_stream(self):
        async def _gen():
            for c in self._chunks:
                yield c
        return _gen()

    async def get_final_message(self):
        return self._final


class _FakeMessages:
    def __init__(self, script, raise_on=None):
        self._script = list(script)
        self.calls = []
        self._raise_on = raise_on

    def stream(self, **kwargs):
        idx = len(self.calls)
        self.calls.append(kwargs)
        if self._raise_on is not None and idx == self._raise_on:
            raise RuntimeError("boom-stream")
        chunks, final = self._script[idx]  # IndexError past the script ⇒ simulated later failure
        return _FakeStreamCtx(chunks, final)


class _FakeClient:
    def __init__(self, script, raise_on=None):
        self.messages = _FakeMessages(script, raise_on)


class _Recorder:
    def __init__(self, result="ok"):
        self.calls = []
        self.result = result

    def __call__(self, name, inp):
        self.calls.append((name, inp))
        return self.result


def _final(stop_reason, content):
    return types.SimpleNamespace(stop_reason=stop_reason, content=content)


def _tooluse(id, name, inp):
    return {"type": "tool_use", "id": id, "name": name, "input": inp}


def _text(t):
    return {"type": "text", "text": t}


def _drive(client, mcp_call, *, tools, max_rounds=8, max_tokens=al.MAX_OUTPUT_TOKENS,
           system=None, messages=None):
    return run(al.drive_anthropic_loop(
        aclient=client, mcp_call=mcp_call, model=al.MODEL_ID,
        system_blocks=system if system is not None else [_text("sys")],
        anthropic_tools=tools,
        messages=messages if messages is not None else [{"role": "user", "content": [_text("q")]}],
        max_rounds=max_rounds, max_tokens=max_tokens))


class DriveAnthropicLoopTest(unittest.TestCase):
    def test_happy_path_streams_runs_tool_and_feeds_result(self):
        client = _FakeClient([
            (["Let me check. "], _final("tool_use", [_tooluse("tu1", "list_vpcs", {"region": "x"})])),
            (["3 VPCs."], _final("end_turn", [_text("3 VPCs.")])),
        ])
        rec = _Recorder("vpc-a,vpc-b,vpc-c")
        deltas = _drive(client, rec, tools=[{"name": "list_vpcs", "input_schema": {}}])
        self.assertEqual(deltas, [{"delta": "Let me check. "}, {"delta": "3 VPCs."}])
        # tool ran exactly once with the model-supplied input
        self.assertEqual(rec.calls, [("list_vpcs", {"region": "x"})])
        # max_tokens passed on the first call
        self.assertEqual(client.messages.calls[0]["max_tokens"], al.MAX_OUTPUT_TOKENS)
        self.assertIn("tools", client.messages.calls[0])
        # the tool_result was fed back on the 2nd model turn
        second_msgs = client.messages.calls[1]["messages"]
        results = [blk for m in second_msgs if m["role"] == "user"
                   for blk in m["content"] if isinstance(blk, dict) and blk.get("type") == "tool_result"]
        self.assertTrue(any(r["tool_use_id"] == "tu1" for r in results))

    def test_max_rounds_cap_forces_final_toolless_turn(self):
        # every turn asks for a tool; cap=2 ⇒ 3 stream calls (2 tool rounds + 1 tool-less synthesis)
        always_tool = ([], _final("tool_use", [_tooluse("t", "list_vpcs", {})]))
        client = _FakeClient([always_tool, always_tool, (["final answer"], _final("end_turn", [_text("final answer")]))])
        rec = _Recorder()
        deltas = _drive(client, rec, tools=[{"name": "list_vpcs"}], max_rounds=2)
        self.assertEqual(len(rec.calls), 2)                 # exactly max_rounds tool calls
        self.assertEqual(len(client.messages.calls), 3)     # bounded — no infinite loop
        self.assertNotIn("tools", client.messages.calls[2])  # final synthesis turn offers no tools
        self.assertIn({"delta": "final answer"}, deltas)

    def test_output_contract_is_delta_str(self):
        client = _FakeClient([(["hello ", "world"], _final("end_turn", [_text("hello world")]))])
        deltas = _drive(client, _Recorder(), tools=[])
        for d in deltas:
            self.assertEqual(list(d.keys()), ["delta"])
            self.assertIsInstance(d["delta"], str)

    def test_no_tools_single_turn(self):
        client = _FakeClient([(["just text"], _final("end_turn", [_text("just text")]))])
        deltas = _drive(client, _Recorder(), tools=[])
        self.assertEqual(deltas, [{"delta": "just text"}])
        self.assertEqual(len(client.messages.calls), 1)

    def test_failsoft_before_first_delta(self):
        client = _FakeClient([(["unused"], _final("end_turn", [_text("x")]))], raise_on=0)
        deltas = _drive(client, _Recorder(), tools=[])
        self.assertEqual(deltas, [{"delta": al._FAILED_DELTA}])

    def test_failsoft_after_first_delta(self):
        # one tool round streams "partial ", then the 2nd model turn errors (script exhausted)
        client = _FakeClient([(["partial "], _final("tool_use", [_tooluse("t", "list_vpcs", {})]))])
        deltas = _drive(client, _Recorder(), tools=[{"name": "list_vpcs"}])
        self.assertEqual(deltas, [{"delta": "partial "}, {"delta": al._INTERRUPTED_DELTA}])

    def test_tool_error_becomes_is_error_result_not_fatal(self):
        def boom(name, inp):
            raise ValueError("tool exploded")
        client = _FakeClient([
            (["trying "], _final("tool_use", [_tooluse("tu1", "list_vpcs", {})])),
            (["recovered"], _final("end_turn", [_text("recovered")])),
        ])
        deltas = _drive(client, boom, tools=[{"name": "list_vpcs"}])
        self.assertEqual(deltas, [{"delta": "trying "}, {"delta": "recovered"}])  # not fatal
        results = [blk for m in client.messages.calls[1]["messages"] if m["role"] == "user"
                   for blk in m["content"] if isinstance(blk, dict) and blk.get("type") == "tool_result"]
        self.assertTrue(any(r.get("is_error") for r in results))


if __name__ == "__main__":
    unittest.main()
