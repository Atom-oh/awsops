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
    stub('streamable_http_sigv4',
         streamablehttp_client_with_sigv4=lambda *a, **k: None,
         streamablehttp_client_with_headers=lambda *a, **k: None)
    stub('boto3', client=lambda *a, **k: None, Session=lambda *a, **k: None)


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


class SsrfGuardTest(unittest.TestCase):
    def test_ip_always_blocked(self):
        # Loopback
        self.assertTrue(agent._ip_always_blocked('127.0.0.1'))
        self.assertTrue(agent._ip_always_blocked('::1'))
        # Link-local (Metadata)
        self.assertTrue(agent._ip_always_blocked('169.254.169.254'))
        self.assertTrue(agent._ip_always_blocked('fe80::1'))
        # Multicast
        self.assertTrue(agent._ip_always_blocked('224.0.0.1'))
        self.assertTrue(agent._ip_always_blocked('ff02::1'))
        # Unspecified / Reserved
        self.assertTrue(agent._ip_always_blocked('0.0.0.0'))
        self.assertTrue(agent._ip_always_blocked('240.0.0.1'))
        # Cloud metadata — ALWAYS blocked even though IPv6 IMDS is ULA (P4 gate fix)
        self.assertTrue(agent._ip_always_blocked('fd00:ec2::254'))      # AWS IPv6 IMDS (fc00::/7 ULA)
        self.assertTrue(agent._ip_always_blocked('fd00:ec2:0:0:0:0:0:254'))  # same, expanded form
        # Public / Private (not always blocked)
        self.assertFalse(agent._ip_always_blocked('8.8.8.8'))
        self.assertFalse(agent._ip_always_blocked('10.0.0.1'))
        self.assertFalse(agent._ip_always_blocked('192.168.1.1'))

    def test_ip_is_private(self):
        # RFC1918
        self.assertTrue(agent._ip_is_private('10.0.0.1'))
        self.assertTrue(agent._ip_is_private('172.16.0.1'))
        self.assertTrue(agent._ip_is_private('192.168.1.1'))
        # ULA
        self.assertTrue(agent._ip_is_private('fc00::1'))
        # Public
        self.assertFalse(agent._ip_is_private('8.8.8.8'))
        # Metadata / Loopback (always blocked, NOT in the _ip_is_private "opt-in" set)
        self.assertFalse(agent._ip_is_private('169.254.169.254'))
        self.assertFalse(agent._ip_is_private('127.0.0.1'))
        self.assertFalse(agent._ip_is_private('fd00:ec2::254'))  # IPv6 IMDS — metadata, not opt-in-able

    def test_assert_host_allowed_basics(self):
        def resolver(host, port, *a, **k):
            # map hosts to IPs for testing
            mapping = {
                'public.com': ['8.8.8.8'],
                'private.local': ['10.0.0.1'],
                'metadata.internal': ['169.254.169.254'],
                'loopback.local': ['127.0.0.1'],
                'mixed.com': ['8.8.8.8', '10.0.0.1'],
                'nxdomain.local': [],
            }
            res = mapping.get(host, [])
            if not res: return []
            # return format: (family, type, proto, canonname, sockaddr)
            return [(2, 1, 6, '', (ip, port)) for ip in res]

        # HTTPS required
        with self.assertRaisesRegex(agent.SsrfBlocked, "HTTPS required"):
            agent._assert_host_allowed("http://public.com", False, resolver=resolver)

        # Public HTTPS allowed
        agent._assert_host_allowed("https://public.com", False, resolver=resolver)

        # Private HTTPS blocked by default
        with self.assertRaisesRegex(agent.SsrfBlocked, "private access disabled"):
            agent._assert_host_allowed("https://private.local", False, resolver=resolver)

        # Private HTTPS allowed with opt-in
        agent._assert_host_allowed("https://private.local", True, resolver=resolver)

        # Metadata ALWAYS blocked
        with self.assertRaisesRegex(agent.SsrfBlocked, "always-blocked"):
            agent._assert_host_allowed("https://metadata.internal", False, resolver=resolver)
        with self.assertRaisesRegex(agent.SsrfBlocked, "always-blocked"):
            agent._assert_host_allowed("https://metadata.internal", True, resolver=resolver)

        # Loopback ALWAYS blocked
        with self.assertRaisesRegex(agent.SsrfBlocked, "always-blocked"):
            agent._assert_host_allowed("https://loopback.local", True, resolver=resolver)

        # Mixed resolution (ANY blocked IP = fail)
        with self.assertRaisesRegex(agent.SsrfBlocked, "private access disabled"):
            agent._assert_host_allowed("https://mixed.com", False, resolver=resolver)
        
        # NXDOMAIN
        with self.assertRaisesRegex(agent.SsrfBlocked, "could not resolve"):
            agent._assert_host_allowed("https://nxdomain.local", True, resolver=resolver)


class IntegrationHelpersTest(unittest.TestCase):
    def test_parse_secret(self):
        self.assertEqual(agent.parse_secret('{"token":"t"}'), {"token": "t"})
        self.assertEqual(agent.parse_secret('raw-val'), {"_raw": "raw-val"})
        self.assertEqual(agent.parse_secret(''), {})
        self.assertEqual(agent.parse_secret(None), {})

    def test_auth_headers(self):
        # api_key
        self.assertEqual(agent.auth_headers('api_key', {"header": "X-API", "value": "k"}), {"X-API": "k"})
        self.assertEqual(agent.auth_headers('api_key', {"api_key": "k"}), {"Authorization": "k"})
        self.assertEqual(agent.auth_headers('api_key', {"_raw": "k"}), {"Authorization": "k"})
        with self.assertRaises(ValueError):
            agent.auth_headers('api_key', {})

        # oauth_client_credentials
        self.assertEqual(agent.auth_headers('oauth_client_credentials', {"token": "t"}), {"Authorization": "Bearer t"})
        self.assertEqual(agent.auth_headers('oauth_client_credentials', {"_raw": "t"}), {"Authorization": "Bearer t"})
        with self.assertRaises(ValueError):
            agent.auth_headers('oauth_client_credentials', {})

        # sigv4
        self.assertEqual(agent.auth_headers('sigv4', {}), {})

        # Unknown
        with self.assertRaises(ValueError):
            agent.auth_headers('unknown', {})

    def test_sigv4_params(self):
        # Explicit service required
        with self.assertRaisesRegex(ValueError, "requires an explicit 'sigv4Service'"):
            agent.sigv4_params('https://abc.com')

        # Derived region (execute-api)
        self.assertEqual(
            agent.sigv4_params('https://abc.execute-api.ap-northeast-2.amazonaws.com/mcp', service='execute-api'),
            ('execute-api', 'ap-northeast-2')
        )

        # Derived region (lambda-url)
        self.assertEqual(
            agent.sigv4_params('https://abc.lambda-url.us-east-1.on.aws/mcp', service='lambda'),
            ('lambda', 'us-east-1')
        )

        # Explicit region override
        self.assertEqual(
            agent.sigv4_params('https://abc.execute-api.us-east-1.amazonaws.com/mcp', service='execute-api', region='ap-northeast-2'),
            ('execute-api', 'ap-northeast-2')
        )

        # Fallback to GATEWAY_REGION
        self.assertEqual(
            agent.sigv4_params('https://abc.com', service='custom'),
            ('custom', agent.GATEWAY_REGION)
        )


class IntegrationToolMergeTest(unittest.TestCase):
    """Task 3 — tool ∩ exposed_tools (admin ceiling) + per-integration failure isolation."""

    def test_select_keeps_only_exposed_preserving_order(self):
        live = [FakeTool('a'), FakeTool('b'), FakeTool('c')]
        # exposed order must not reorder output — live order is preserved.
        self.assertEqual(names(agent.select_integration_tools(live, ['c', 'a'])), ['a', 'c'])

    def test_select_empty_exposed_contributes_nothing(self):
        # Admin ceiling: a READ integration with no exposed_tools contributes NOTHING (not "all").
        live = [FakeTool('a'), FakeTool('b')]
        self.assertEqual(agent.select_integration_tools(live, []), [])

    def test_select_tools_not_in_exposed_are_dropped(self):
        live = [FakeTool('a'), FakeTool('b')]
        self.assertEqual(names(agent.select_integration_tools(live, ['a', 'nope'])), ['a'])

    def test_select_empty_live_yields_empty(self):
        self.assertEqual(agent.select_integration_tools([], ['a']), [])

    def test_gather_unions_healthy_integrations(self):
        specs = [{'name': 'x'}, {'name': 'y'}]
        def connect(spec):
            return [FakeTool(spec['name'] + '_t')]
        self.assertEqual(names(agent.gather_integration_tools(specs, connect)), ['x_t', 'y_t'])

    def test_gather_drops_failed_keeps_others_mixed_result(self):
        # R2 gate: integration A RAISES, B SUCCEEDS → only B's tools appear, gather NEVER raises.
        specs = [{'name': 'A', 'endpoint': 'https://a'}, {'name': 'B', 'endpoint': 'https://b'}]
        def connect(spec):
            if spec['name'] == 'A':
                raise agent.SsrfBlocked('A is blocked')
            return [FakeTool('b_tool')]
        out = agent.gather_integration_tools(specs, connect)
        self.assertEqual(names(out), ['b_tool'])

    def test_gather_never_raises_when_all_fail(self):
        specs = [{'name': 'A'}, {'name': 'B'}]
        def connect(spec):
            raise ValueError('boom')
        self.assertEqual(agent.gather_integration_tools(specs, connect), [])

    def test_gather_empty_and_none_specs(self):
        self.assertEqual(agent.gather_integration_tools([], lambda s: [FakeTool('x')]), [])
        self.assertEqual(agent.gather_integration_tools(None, lambda s: [FakeTool('x')]), [])

    def test_gather_integration_whose_exposed_filters_everything(self):
        # connect returns [] (exposed filtered all out) → that integration contributes [] but others survive.
        specs = [{'name': 'empty'}, {'name': 'full'}]
        def connect(spec):
            return [] if spec['name'] == 'empty' else [FakeTool('f')]
        self.assertEqual(names(agent.gather_integration_tools(specs, connect)), ['f'])

    def test_dedup_keeps_first_on_collision_gateway_precedence(self):
        # P4 gate fix: gateway tools precede integration tools → gateway wins a name collision; order kept.
        gateway = [FakeTool('shared'), FakeTool('gw_only')]
        integ = [FakeTool('shared'), FakeTool('int_only')]
        deduped = agent._dedup_by_tool_name(gateway + integ)
        self.assertEqual(names(deduped), ['shared', 'gw_only', 'int_only'])



class TestDatasourceGuidance(unittest.TestCase):
    def test_monitoring_prompt_names_query_languages(self):
        # Prometheus & ClickHouse moved to the Observability section; monitoring keeps the
        # still-here datasources (Mimir→PromQL, Loki→LogQL, Tempo→TraceQL).
        mon = agent.SKILL_BASE["monitoring"]
        for lang in ("PromQL", "LogQL", "TraceQL"):
            self.assertIn(lang, mon)
        self.assertIn("Datasource schemas", mon)  # tells the agent to use the injected cache

    def test_observability_prompt_covers_prometheus_and_clickhouse(self):
        obs = agent.SKILL_BASE["observability"]
        for token in ("Prometheus", "PromQL", "ClickHouse", "SQL"):
            self.assertIn(token, obs)
        self.assertIn("Datasource schemas", obs)  # uses the injected schema cache

    def test_observability_aliases_to_external_obs_gateway(self):
        self.assertEqual(agent._GATEWAY_ALIAS.get("observability"), "external-obs")

    def test_resolve_gateway_key_handles_discovery_and_env_spellings(self):
        # Discovery path: v2 gateway `awsops-v2-external-obs-gateway` → key `v2-external-obs`.
        disc = {"network": "u", "ops": "u", "v2-external-obs": "u"}
        self.assertEqual(agent._resolve_gateway_key("observability", disc), "v2-external-obs")
        # Env fallback path: GATEWAYS_JSON uses the canonical `external-obs`.
        env = {"network": "u", "ops": "u", "external-obs": "u"}
        self.assertEqual(agent._resolve_gateway_key("observability", env), "external-obs")
        # The 8 sections pass through unchanged (no alias, key present).
        self.assertEqual(agent._resolve_gateway_key("network", disc), "network")
        # Unknown / unprovisioned → DEFAULT_GATEWAY (never a hard crash).
        self.assertEqual(agent._resolve_gateway_key("observability", {"ops": "u"}), agent.DEFAULT_GATEWAY)


class TestAntiHallucinationFooter(unittest.TestCase):
    """The data agent once fabricated a non-existent 'Infra 에이전트'. The footer must give the real
    roster + forbid inventing agents, and tell the agent to be honest when it lacks a tool."""

    def test_footer_forbids_inventing_agents(self):
        f = agent.COMMON_FOOTER.lower()
        self.assertTrue("invent" in f or "make up" in f or "지어내" in agent.COMMON_FOOTER,
                        "footer must forbid inventing agent names")

    def test_footer_lists_real_section_roster(self):
        f = agent.COMMON_FOOTER.lower()
        for section in ("network", "data", "security", "cost", "monitoring", "ops"):
            self.assertIn(section, f)
        # the fabricated name must NOT be presented as a real agent
        self.assertNotIn("infra agent", f)

    def test_footer_tells_agent_to_be_honest_when_lacking_a_tool(self):
        f = agent.COMMON_FOOTER.lower()
        self.assertIn("tool", f)


class TestOpsTopologyPrompt(unittest.TestCase):
    """Ops gateway is the inventory_read MCP home — its prompt must route topology/unused asks
    to the new tools instead of refusing or punting."""

    def test_ops_prompt_mentions_inventory_tools(self):
        ops = agent.SKILL_BASE["ops"]
        for tool in ("find_unused_resources", "get_topology", "query_inventory"):
            self.assertIn(tool, ops)


if __name__ == '__main__':
    unittest.main()
