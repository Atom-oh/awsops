"""Unit tests for agent.py pure helpers. Stdlib unittest only (no strands/bedrock).

Run from this directory:  cd agent && python3 -m unittest test_agent

agent.py loads strands / bedrock_agentcore and instantiates a BedrockModel at import
time, none of which are available locally. We stub those modules in sys.modules BEFORE
importing agent, so the pure helper `_filter_tools` can be imported and tested in
isolation. This keeps the change within Task 2's file scope (agent.py + test_agent.py).
"""
import sys
import types
import unittest


def _install_stubs():
    def stub(name, **attrs):
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m
        return m

    strands = stub('strands', Agent=lambda *a, **k: None)
    models = stub('strands.models', BedrockModel=lambda *a, **k: object(), CacheConfig=lambda *a, **k: object())
    strands.models = models
    stub('strands.tools')
    stub('strands.tools.mcp')
    stub('strands.tools.mcp.mcp_client', MCPClient=lambda *a, **k: None)
    stub('botocore')
    stub('botocore.credentials', Credentials=object)
    stub('bedrock_agentcore')
    stub('bedrock_agentcore.runtime',
         BedrockAgentCoreApp=lambda *a, **k: types.SimpleNamespace(entrypoint=lambda f: f))
    stub('streamable_http_sigv4', streamablehttp_client_with_sigv4=lambda *a, **k: None)
    stub('boto3')


_install_stubs()
import agent  # noqa: E402  (import after stubs are installed)


class FakeTool:
    def __init__(self, name):
        self.tool_name = name


def names(tools):
    return [t.tool_name for t in tools]


class FilterToolsTest(unittest.TestCase):
    def test_none_allowlist_returns_all_unchanged(self):
        tools = [FakeTool('a'), FakeTool('b')]
        self.assertIs(agent._filter_tools(tools, None), tools)

    def test_empty_allowlist_returns_all_unchanged_not_deny_all(self):
        # [] means "no restriction" (the resolver omits the key when empty), NOT deny-all.
        tools = [FakeTool('a'), FakeTool('b')]
        self.assertIs(agent._filter_tools(tools, []), tools)

    def test_filters_to_allowlist_preserving_tool_order(self):
        tools = [FakeTool('a'), FakeTool('b'), FakeTool('c')]
        # allowlist order must NOT change output order — original tool order is preserved.
        self.assertEqual(names(agent._filter_tools(tools, ['c', 'a'])), ['a', 'c'])

    def test_unknown_names_in_allowlist_are_ignored(self):
        tools = [FakeTool('a')]
        self.assertEqual(names(agent._filter_tools(tools, ['a', 'does-not-exist'])), ['a'])

    def test_duplicate_allowlist_entries_are_safe(self):
        tools = [FakeTool('a'), FakeTool('b')]
        self.assertEqual(names(agent._filter_tools(tools, ['a', 'a'])), ['a'])

    def test_no_match_yields_empty_tool_set(self):
        # A non-empty allowlist matching nothing → tool-less (safe), not "all tools".
        tools = [FakeTool('a'), FakeTool('b')]
        self.assertEqual(agent._filter_tools(tools, ['zzz']), [])


if __name__ == '__main__':
    unittest.main()
