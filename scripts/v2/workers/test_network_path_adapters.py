"""Table-driven tests for network_path_adapters.py's pure evaluators."""
import network_path_adapters as ad


# ── Security Groups ──────────────────────────────────────────────────────────────────────────────

class TestSecurityGroup:
    def test_matches_cidr_rule(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "10.0.0.0/8"}]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip="10.1.2.3")
        assert r["status"] == "allowed"

    def test_no_match_is_blocked(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "10.0.0.0/8"}]
        r = ad.eval_security_group(rules, "tcp", 22, peer_ip="10.1.2.3")
        assert r["status"] == "blocked"

    def test_protocol_number_and_name_are_equivalent(self):
        rules = [{"sg_id": "sg-1", "protocol": "6", "from_port": 80, "to_port": 80, "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "tcp", 80, peer_ip="1.2.3.4")
        assert r["status"] == "allowed"

    def test_all_protocols_wildcard(self):
        rules = [{"sg_id": "sg-1", "protocol": "-1", "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "udp", 53, peer_ip="8.8.8.8")
        assert r["status"] == "allowed"

    def test_port_range(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 1024, "to_port": 65535, "cidr": "0.0.0.0/0"}]
        assert ad.eval_security_group(rules, "tcp", 50000, peer_ip="1.1.1.1")["status"] == "allowed"
        assert ad.eval_security_group(rules, "tcp", 80, peer_ip="1.1.1.1")["status"] == "blocked"

    def test_referenced_security_group_match(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 5432, "to_port": 5432,
                  "referenced_group_id": "sg-db"}]
        r = ad.eval_security_group(rules, "tcp", 5432, peer_sg_ids=["sg-db"])
        assert r["status"] == "allowed"

    def test_missing_peer_identity_is_unknown_not_blocked(self):
        # MAJOR fix: missing/unparseable peer identity must never invent a confident `blocked`.
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip=None, peer_sg_ids=None)
        assert r["status"] == "unknown"

    def test_multi_sg_union(self):
        # Second SG's rule is the one that actually allows — union across all attached SGs.
        rules = [
            {"sg_id": "sg-1", "protocol": "tcp", "from_port": 22, "to_port": 22, "cidr": "10.0.0.0/8"},
            {"sg_id": "sg-2", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"},
        ]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip="203.0.113.5")
        assert r["status"] == "allowed"
        assert r["resource"] == "sg-2"


# ── NACL ──────────────────────────────────────────────────────────────────────────────────────────

class TestNacl:
    def test_forward_deny_first_match(self):
        fwd = [{"rule_number": 100, "protocol": "tcp", "from_port": 443, "to_port": 443, "action": "deny"},
               {"rule_number": 200, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443)
        assert r["status"] == "blocked"

    def test_forward_allow_first_match_lower_rule_number_wins(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"},
               {"rule_number": 200, "protocol": "tcp", "from_port": 443, "to_port": 443, "action": "deny"}]
        # Return rule is scoped to just the probed ephemeral port (not the full range) so this test
        # stays focused on forward first-match-wins, independent of the unrestricted-return case.
        ret = [{"rule_number": 100, "protocol": "tcp", "from_port": ad.EPHEMERAL_PROBE_PORT,
                 "to_port": ad.EPHEMERAL_PROBE_PORT, "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        # Forward allowed at rule 100 (evaluated before rule 200); return also allowed but scoped ->
        # conditional (ephemeral probe only), not a flat allow.
        assert r["status"] == "conditional"

    def test_implicit_deny_default(self):
        fwd = [{"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443)
        assert r["status"] == "blocked"

    def test_return_denied_blocks_even_when_forward_allowed(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "tcp",
                 "from_port": 0, "to_port": ad.EPHEMERAL_PROBE_PORT - 1, "action": "allow"},
                {"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "blocked"

    def test_scoped_return_range_stays_conditional_not_allowed(self):
        # 2026-08-19 review fix: a return rule scoped to a NARROW range (here: exactly the probed
        # ephemeral port, not the full ephemeral space) never generalizes to a flat allow.
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "tcp", "from_port": ad.EPHEMERAL_PROBE_PORT,
                 "to_port": ad.EPHEMERAL_PROBE_PORT, "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "conditional"

    def test_genuinely_unrestricted_return_range_is_allowed(self):
        # 2026-08-19 review fix, PART 2 (this PR): when the return rule set is genuinely,
        # unambiguously unrestricted (protocol -1 / wildcard, no port scoping at all — covering the
        # FULL ephemeral range, not just the one probed port), the scoped-verdict caveat does not
        # apply and candidate-level `allowed` must be reachable.
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "allowed"

    def test_unrestricted_wide_port_range_return_is_allowed(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "tcp", "from_port": 0, "to_port": 65535, "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "allowed"

    # ── CIDR scoping (MAJOR fix: _first_match ignored CIDR scope entirely) ─────────────────────

    def test_allow_rule_scoped_to_unrelated_cidr_does_not_match(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "192.168.0.0/16", "action": "allow"},
               {"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443, peer_ip="10.1.2.3")
        # The only allow rule is scoped to an unrelated CIDR — the peer doesn't match it, so the
        # implicit deny is what actually applies. Must NOT be a false "not blocked".
        assert r["status"] == "blocked"

    def test_allow_rule_scoped_to_matching_cidr_does_match(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443, peer_ip="10.1.2.3")
        assert r["status"] == "allowed"

    def test_deny_rule_scoped_to_unrelated_cidr_does_not_block(self):
        fwd = [{"rule_number": 50, "protocol": "-1", "cidr": "192.168.0.0/16", "action": "deny"},
               {"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443, peer_ip="10.1.2.3")
        # A narrow deny scoped to an unrelated CIDR must not falsely block a peer it doesn't cover —
        # the peer falls through to the broader allow rule at 100.
        assert r["status"] == "allowed"


# ── Routes ────────────────────────────────────────────────────────────────────────────────────────

class TestRoute:
    def test_longest_prefix_wins(self):
        rt = [{"destination_cidr": "0.0.0.0/0", "target": "igw-1", "state": "active"},
              {"destination_cidr": "10.0.1.0/24", "target": "local", "state": "active"}]
        r = ad.eval_route(rt, "10.0.1.5")
        assert r["target_resource"] if "target_resource" in r else True
        assert r["resource"] == "local"

    def test_blackhole_route_blocks(self):
        rt = [{"destination_cidr": "192.168.0.0/16", "target": "pcx-1", "state": "blackhole"}]
        r = ad.eval_route(rt, "192.168.1.1")
        assert r["status"] == "blocked"

    def test_no_covering_route_blocks(self):
        rt = [{"destination_cidr": "10.0.0.0/8", "target": "local", "state": "active"}]
        r = ad.eval_route(rt, "8.8.8.8")
        assert r["status"] == "blocked"

    def test_default_route_covers_internet(self):
        rt = [{"destination_cidr": "0.0.0.0/0", "target": "nat-1", "state": "active"}]
        r = ad.eval_route(rt, "8.8.8.8")
        assert r["status"] == "allowed"
        assert r["resource"] == "nat-1"

    def test_one_ended_source_side_only_needs_no_destination_eni(self):
        # Same function, no destination ENI at all — CIDR-only destination for internet/on-prem.
        rt = [{"destination_cidr": "203.0.113.0/24", "target": "vgw-1", "state": "active"}]
        r = ad.eval_route(rt, "203.0.113.0/24")
        assert r["status"] == "allowed"

    def test_missing_destination_is_unknown_not_blocked(self):
        # MAJOR fix: missing destination must never invent a confident `blocked`.
        rt = [{"destination_cidr": "0.0.0.0/0", "target": "igw-1", "state": "active"}]
        r = ad.eval_route(rt, None)
        assert r["status"] == "unknown"

    def test_malformed_destination_is_unknown_not_blocked(self):
        rt = [{"destination_cidr": "0.0.0.0/0", "target": "igw-1", "state": "active"}]
        r = ad.eval_route(rt, "not-an-ip-or-cidr")
        assert r["status"] == "unknown"


# ── TGW ───────────────────────────────────────────────────────────────────────────────────────────

class TestTgw:
    def test_attachment_not_available_blocks(self):
        r = ad.eval_tgw("deleting", True, True, {"state": "active", "attachment_id": "tgw-attach-1"})
        assert r["status"] == "blocked"

    def test_not_associated_blocks(self):
        r = ad.eval_tgw("available", False, True, None)
        assert r["status"] == "blocked"

    def test_blackhole_blocks(self):
        r = ad.eval_tgw("available", True, True, {"state": "blackhole", "attachment_id": "tgw-attach-1"})
        assert r["status"] == "blocked"

    def test_no_matching_route_no_propagation_blocks(self):
        r = ad.eval_tgw("available", True, False, None)
        assert r["status"] == "blocked"

    def test_propagation_enabled_but_no_route_is_unknown_stale_cache(self):
        r = ad.eval_tgw("available", True, True, None)
        assert r["status"] == "unknown"

    def test_forward_route_present_is_conditional_asymmetric_return_risk(self):
        r = ad.eval_tgw("available", True, True, {"state": "active", "attachment_id": "tgw-attach-1"})
        assert r["status"] == "conditional"


# ── Peering / VPN / DX boundary classification ──────────────────────────────────────────────────

class TestBoundaryClassification:
    def test_peering_active(self):
        assert ad.eval_peering("active")["status"] == "allowed"

    def test_peering_not_active(self):
        assert ad.eval_peering("pending-acceptance")["status"] == "blocked"

    def test_vpn_up_with_route(self):
        r = ad.eval_vpn_or_dx("vpn", "up", True)
        assert r["status"] == "allowed"

    def test_vpn_down(self):
        r = ad.eval_vpn_or_dx("vpn", "down", True)
        assert r["status"] == "blocked"

    def test_dx_up_no_route(self):
        r = ad.eval_vpn_or_dx("dx", "up", False)
        assert r["status"] == "blocked"


# ── Network Firewall ─────────────────────────────────────────────────────────────────────────────

class TestNetworkFirewall:
    def test_pass(self):
        assert ad.eval_network_firewall("pass")["status"] == "allowed"

    def test_drop(self):
        assert ad.eval_network_firewall("drop")["status"] == "blocked"

    def test_reject(self):
        assert ad.eval_network_firewall("reject")["status"] == "blocked"

    def test_uninspectable_form(self):
        r = ad.eval_network_firewall("pass", uninspectable=True)
        assert r["status"] == "unknown"

    def test_unrecognized_action_is_unknown(self):
        r = ad.eval_network_firewall("alert")
        assert r["status"] == "unknown"


# ── ALB listener ──────────────────────────────────────────────────────────────────────────────────

class TestAlbListener:
    def test_first_match_wins(self):
        rules = [
            {"priority": 1, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
             "action": {"type": "forward", "target_group_arn": "tg-api"}},
            {"priority": 2, "conditions": [], "action": {"type": "forward", "target_group_arn": "tg-default"}},
        ]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/api/orders"})
        assert r["status"] == "allowed"
        assert "tg-api" in r["summary"]

    def test_fixed_response_4xx_blocks(self):
        rules = [{"priority": 1, "conditions": [], "action": {"type": "fixed-response", "status_code": 403}}]
        r = ad.eval_alb_listener(rules, {})
        assert r["status"] == "blocked"

    def test_fixed_response_2xx_allows(self):
        rules = [{"priority": 1, "conditions": [], "action": {"type": "fixed-response", "status_code": 200}}]
        r = ad.eval_alb_listener(rules, {})
        assert r["status"] == "allowed"

    def test_redirect_is_conditional(self):
        rules = [{"priority": 1, "conditions": [], "action": {"type": "redirect"}}]
        r = ad.eval_alb_listener(rules, {})
        assert r["status"] == "conditional"

    def test_no_match_no_default_blocks(self):
        rules = [{"priority": 1, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
                  "action": {"type": "forward"}}]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/other"})
        assert r["status"] == "blocked"


class TestTargetGroupHealth:
    def test_no_targets(self):
        assert ad.eval_target_group_health(0, 0)["status"] == "blocked"

    def test_all_unhealthy(self):
        assert ad.eval_target_group_health(0, 3)["status"] == "blocked"

    def test_partial_healthy_is_conditional(self):
        assert ad.eval_target_group_health(1, 3)["status"] == "conditional"

    def test_all_healthy(self):
        assert ad.eval_target_group_health(3, 3)["status"] == "allowed"


# ── K8s NetworkPolicy ────────────────────────────────────────────────────────────────────────────

class TestK8sNetworkPolicy:
    def test_no_policy_selects_pod_default_allow(self):
        r = ad.eval_k8s_network_policy([], {"app": "orders"}, "ingress")
        assert r["status"] == "allowed"

    def test_selected_default_deny_no_matching_rule(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        assert r["status"] == "blocked"

    def test_selected_matching_pod_selector_allows(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"})
        assert r["status"] == "allowed"

    def test_ip_block_peer_match(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["egress"], "egress": [
            {"to": [{"ip_block": {"cidr": "10.0.0.0/8"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip="10.1.2.3")
        assert r["status"] == "allowed"

    def test_empty_peer_list_allows_all(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [{}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress")
        assert r["status"] == "allowed"

    # ── MAJOR fail-open fix: the docstring's OWN documented shape uses canonical K8s casing ──────

    def test_canonical_cased_policy_types_select_the_pod(self):
        """The docstring's documented input shape is `"policy_types": ["Ingress","Egress"]`
        (Kubernetes canonical casing) — with that EXACT shape, a policy selecting the pod for
        ingress must actually select it (previously: lowercase-only comparison meant no policy
        ever selected the pod under the documented shape, so a default-deny pod fail-opened to
        `allowed`)."""
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["Ingress", "Egress"],
                     "ingress": [{"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        # Selected (canonical-cased policy_types matched) + no rule matches the actual peer -> blocked
        # (default-deny), NOT allowed — proving the pod is genuinely selected, not fail-open.
        assert r["status"] == "blocked"

    def test_canonical_cased_policy_types_matching_peer_allows(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["Ingress"],
                     "ingress": [{"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"})
        assert r["status"] == "allowed"


# ── Calico / Cilium / Istio bounded stubs ───────────────────────────────────────────────────────

class TestMeshPolicyStub:
    def test_crd_missing_is_unknown(self):
        r = ad.eval_mesh_policy_stub("calico", None, crd_present=False)
        assert r["status"] == "unknown"

    def test_unsupported_version_is_unknown(self):
        r = ad.eval_mesh_policy_stub("cilium", "cilium.io/v1alpha1", crd_present=True)
        assert r["status"] == "unknown"

    def test_supported_version_still_unknown_not_full_eval(self):
        # Even a "supported" schema version never returns allowed/blocked in this release — this is
        # a bounded stub, not a full live evaluator (see the report).
        r = ad.eval_mesh_policy_stub("calico", "projectcalico.org/v3", crd_present=True)
        assert r["status"] == "unknown"

    def test_never_returns_allowed_or_blocked(self):
        for kind, version, present in [
            ("calico", "projectcalico.org/v3", True), ("cilium", "cilium.io/v2", True),
            ("istio-virtualservice", "networking.istio.io/v1", True),
            ("istio-authorizationpolicy", None, False),
        ]:
            r = ad.eval_mesh_policy_stub(kind, version, present)
            assert r["status"] not in ("allowed", "blocked")
