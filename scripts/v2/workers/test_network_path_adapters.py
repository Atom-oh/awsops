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

    # ── item 9: partial peer identity (known SG but no IP, or vice versa) must never yield a
    #    confident `blocked` when a CIDR/SG-reference rule couldn't be evaluated ────────────────

    def test_known_peer_sg_but_missing_peer_ip_leaves_cidr_rule_unknown(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"}]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip=None, peer_sg_ids=["sg-peer"])
        assert r["status"] == "unknown"

    def test_known_peer_ip_but_missing_peer_sg_ids_leaves_sg_reference_rule_unknown(self):
        rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 5432, "to_port": 5432,
                  "referenced_group_id": "sg-db"}]
        r = ad.eval_security_group(rules, "tcp", 5432, peer_ip="10.1.2.3", peer_sg_ids=None)
        assert r["status"] == "unknown"

    def test_partial_data_still_confidently_allowed_when_a_different_rule_matches(self):
        # The CIDR rule is unevaluable (no peer_ip), but a separate SG-reference rule DOES
        # confidently match via peer_sg_ids — the confident match must win over `unknown`.
        rules = [
            {"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443, "cidr": "0.0.0.0/0"},
            {"sg_id": "sg-2", "protocol": "tcp", "from_port": 443, "to_port": 443,
             "referenced_group_id": "sg-db"},
        ]
        r = ad.eval_security_group(rules, "tcp", 443, peer_ip=None, peer_sg_ids=["sg-db"])
        assert r["status"] == "allowed"
        assert r["resource"] == "sg-2"

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

    # ── L4 finding #10: deny-side asymmetry — a probe-scoped return DENY must not generalize ──────

    def test_return_deny_scoped_to_probed_port_only_is_conditional_not_blocked(self):
        """A return-path deny that matches ONLY because it covers the single probed ephemeral port
        (49152) must NOT generalize to a confident `blocked` — a different ephemeral port might
        still be allowed. Before this fix, ANY matched deny (however narrowly scoped) produced a
        confident `blocked`, asymmetric with the allow-side scoping fix."""
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 50, "protocol": "tcp", "from_port": ad.EPHEMERAL_PROBE_PORT,
                 "to_port": ad.EPHEMERAL_PROBE_PORT, "action": "deny"},
               {"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "conditional"

    # ── item 1: a CIDR-scoped entry with NO peer_ip must never yield a confident verdict ──────────

    def test_cidr_scoped_forward_entry_with_no_peer_ip_is_unknown_not_a_confident_match(self):
        """Before this fix, `peer_ip is None` short-circuited the CIDR scoping check entirely,
        letting the first proto/port-matching entry win regardless of CIDR — a confident verdict
        from missing evidence. The only forward entry is CIDR-scoped and peer_ip is unavailable, so
        this must be `unknown`, not a confident `allowed` (nor a confident `blocked`)."""
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"},
               {"rule_number": 32767, "action": "deny"}]
        r = ad.eval_nacl(fwd, [], "tcp", 443, peer_ip=None)
        assert r["status"] == "unknown"

    def test_cidr_scoped_return_entry_with_no_peer_ip_is_unknown_even_when_forward_resolves(self):
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443, peer_ip=None)
        assert r["status"] == "unknown"

    def test_cidr_scoped_entry_with_peer_ip_present_still_resolves_confidently(self):
        # Regression guard: supplying peer_ip must still produce the pre-existing confident verdict.
        fwd = [{"rule_number": 100, "protocol": "-1", "cidr": "10.0.0.0/8", "action": "allow"}]
        ret = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443, peer_ip="10.1.2.3")
        assert r["status"] == "allowed"

    def test_return_deny_covering_full_ephemeral_range_is_confidently_blocked(self):
        """A deny that genuinely spans the full 0-65535 ephemeral range (unrestricted) legitimately
        blocks every ephemeral port, so a confident `blocked` remains correct."""
        fwd = [{"rule_number": 100, "protocol": "-1", "action": "allow"}]
        ret = [{"rule_number": 50, "protocol": "tcp", "from_port": 0, "to_port": 65535,
                 "action": "deny"}]
        r = ad.eval_nacl(fwd, ret, "tcp", 443)
        assert r["status"] == "blocked"


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

    def test_no_match_and_no_default_action_present_is_unknown_not_blocked(self):
        """L2 finding #5a: a real ALB listener ALWAYS has a default action — an input rule set
        that omits one entirely is missing data, not a confirmed deny. Must be `unknown`, never a
        confident `blocked` (the same "missing data never yields a confident deny" fix already
        applied to eval_security_group/eval_route)."""
        rules = [{"priority": 1, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
                  "action": {"type": "forward"}}]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/other"})
        assert r["status"] == "unknown"

    def test_no_match_but_default_action_present_blocks(self):
        """When the rule set DOES include the always-present default action (priority literal
        "default", ELBv2's own value) and it also fails to match, `blocked` is the correct,
        confident verdict."""
        rules = [
            {"priority": 1, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
             "action": {"type": "forward"}},
            {"priority": "default", "conditions": [{"field": "path-pattern", "values": ["/never/*"]}],
             "action": {"type": "forward"}},
        ]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/other"})
        assert r["status"] == "blocked"

    def test_default_priority_string_does_not_crash_sort(self):
        """L2 finding #5b: `sorted(rules, key=priority)` raised TypeError on ELBv2's literal
        `"default"` priority value (int vs str comparison) — must sort last instead of crashing."""
        rules = [
            {"priority": "default", "conditions": [], "action": {"type": "forward", "target_group_arn": "tg-default"}},
            {"priority": 5, "conditions": [{"field": "path-pattern", "values": ["/api/*"]}],
             "action": {"type": "forward", "target_group_arn": "tg-api"}},
        ]
        r = ad.eval_alb_listener(rules, {"path-pattern": "/api/orders"})
        assert r["status"] == "allowed"
        assert "tg-api" in r["summary"]  # the numbered rule, not the default, wins

    def test_host_header_wildcard_matches(self):
        """L2 finding #5c: host-header wildcards (`*.example.com`) must match, mirroring ALB's own
        glob semantics — previously only path-pattern implemented `*`."""
        rules = [{"priority": 1, "conditions": [{"field": "host-header", "values": ["*.example.com"]}],
                  "action": {"type": "forward", "target_group_arn": "tg-wild"}}]
        r = ad.eval_alb_listener(rules, {"host-header": "api.example.com"})
        assert r["status"] == "allowed"
        assert "tg-wild" in r["summary"]

    def test_host_header_wildcard_does_not_match_unrelated_host(self):
        rules = [{"priority": 1, "conditions": [{"field": "host-header", "values": ["*.example.com"]}],
                  "action": {"type": "forward", "target_group_arn": "tg-wild"}},
                 {"priority": "default", "conditions": [], "action": {"type": "fixed-response", "status_code": 404}}]
        r = ad.eval_alb_listener(rules, {"host-header": "api.other.com"})
        assert r["status"] == "blocked"


class TestNaclLayerParam:
    def test_default_layer_is_nacl(self):
        r = ad.eval_nacl([{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                          [{"rule_number": 100, "protocol": "-1", "action": "allow"}], "tcp", 443)
        assert r["layer"] == "nacl"

    def test_custom_layer_name_is_threaded_through_every_branch(self):
        """L4 finding #13: eval_nacl must be reusable for a second (destination-side) pass under a
        distinct layer name — every returned dict (blocked-forward, blocked-return, allowed,
        conditional) must carry the CALLER's layer name, not a hardcoded "nacl"."""
        blocked_fwd = ad.eval_nacl([], [], "tcp", 443, layer="nacl-dst")
        assert blocked_fwd["layer"] == "nacl-dst"
        blocked_ret = ad.eval_nacl([{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                                    [], "tcp", 443, layer="nacl-dst")
        assert blocked_ret["layer"] == "nacl-dst"
        allowed = ad.eval_nacl([{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                                [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                                "tcp", 443, layer="nacl-dst")
        assert allowed["layer"] == "nacl-dst"
        conditional = ad.eval_nacl(
            [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
            [{"rule_number": 100, "protocol": "tcp", "action": "allow",
              "from_port": ad.EPHEMERAL_PROBE_PORT, "to_port": ad.EPHEMERAL_PROBE_PORT}],
            "tcp", 443, layer="nacl-dst")
        assert conditional["layer"] == "nacl-dst"


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
        # item 2c: a bare podSelector (no namespaceSelector) is scoped to the policy's OWN
        # namespace — confirming same-namespace is required for a confident `allowed`.
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"},
                                        policy_namespace="orders-ns", peer_namespace="orders-ns")
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
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"},
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    # ── L4 finding #10a: policyTypes OMITTED entirely must still apply K8s' real defaulting ──────

    def test_omitted_policy_types_still_selects_pod_for_ingress_default_deny(self):
        """A policy with NO `policy_types` key at all still selects the pod for Ingress (K8s
        default: [Ingress], or [Ingress, Egress] if `egress` is present) — previously this policy
        was silently invisible (no key present -> never selected -> fail-open to `allowed`)."""
        policies = [{"pod_selector": {"app": "orders"},
                     "ingress": [{"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        assert r["status"] == "blocked"  # genuinely selected + default-deny, not fail-open allowed

    def test_omitted_policy_types_does_not_select_pod_for_egress_without_egress_key(self):
        """The same omitted-policyTypes policy must NOT apply to Egress unless the `egress` key is
        itself present — Ingress-only defaulting must not overreach into Egress."""
        policies = [{"pod_selector": {"app": "orders"},
                     "ingress": [{"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip="10.0.0.1")
        assert r["status"] == "allowed"  # not selected for egress -> genuinely default-allow

    def test_omitted_policy_types_with_egress_key_present_selects_for_egress_too(self):
        policies = [{"pod_selector": {"app": "orders"},
                     "egress": [{"to": [{"ip_block": {"cidr": "10.0.0.0/8"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip="192.168.1.1")
        assert r["status"] == "blocked"  # selected via `egress` key presence, peer doesn't match

    # ── L4 finding #10b: a rule's own `ports` restriction must actually be evaluated ────────────

    def test_port_restricted_rule_blocks_a_different_port(self):
        policies = [{"pod_selector": {"app": "dns"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "client"}}], "ports": [{"protocol": "UDP", "port": 53}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "dns"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="tcp", port=8080)
        assert r["status"] == "blocked"

    def test_port_restricted_rule_allows_the_matching_port(self):
        policies = [{"pod_selector": {"app": "dns"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "client"}}], "ports": [{"protocol": "UDP", "port": 53}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "dns"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="udp", port=53,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    def test_rule_with_no_ports_field_allows_any_port(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress",
                                        peer_labels={"app": "gateway"}, protocol="tcp", port=9999,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    def test_port_range_via_end_port_matches(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}],
             "ports": [{"protocol": "TCP", "port": 8000, "endPort": 8100}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress",
                                        peer_labels={"app": "gateway"}, protocol="tcp", port=8050,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    # ── item 2b: named ports must never confidently deny ────────────────────────────────────────

    def test_named_port_that_cannot_be_resolved_is_unknown_not_blocked(self):
        """A rule restricted to a named port ("port": "http") that this pure adapter has no
        Service-port-name resolution for must not be treated as a confident non-match (the old
        `int()` conversion silently swallowed the ValueError via a bare `continue`, producing a
        false `blocked`)."""
        policies = [{"pod_selector": {"app": "web"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "client"}}],
             "ports": [{"protocol": "TCP", "port": "http"}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "web"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="tcp", port=80,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "unknown"

    def test_named_port_alongside_a_confidently_matching_port_still_allows(self):
        """When another, numeric ports entry in the SAME rule confidently matches, that confident
        match wins — an unresolvable named port elsewhere must not downgrade an otherwise-confident
        allow."""
        policies = [{"pod_selector": {"app": "web"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "client"}}],
             "ports": [{"protocol": "TCP", "port": "http"}, {"protocol": "TCP", "port": 80}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "web"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="tcp", port=80,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "allowed"

    def test_named_port_unresolved_but_peer_definitely_mismatches_stays_confident_blocked(self):
        """MINOR fix (round 2): the rule's own peer (podSelector `app: other`) definitively does not
        match the flow's peer (`app: client`) regardless of port — this rule is irrelevant, and must
        not taint the verdict to `unknown` just because ITS OWN port entry happens to be an
        unresolvable named port. Only a rule whose peers WOULD otherwise match, but whose port can't
        be resolved, should downgrade to `unknown` (see the two tests above)."""
        policies = [{"pod_selector": {"app": "web"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "other"}}],
             "ports": [{"protocol": "TCP", "port": "http"}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "web"}, "ingress",
                                        peer_labels={"app": "client"}, protocol="tcp", port=80,
                                        policy_namespace="ns", peer_namespace="ns")
        assert r["status"] == "blocked"

    # ── item 2a: partial peer data (podSelector w/o peer_labels, ipBlock w/o peer_ip) -> unknown ──

    def test_pod_selector_peer_with_no_peer_labels_is_unknown_not_blocked(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels=None)
        assert r["status"] == "unknown"

    def test_ip_block_peer_with_no_peer_ip_is_unknown_not_blocked(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["egress"], "egress": [
            {"to": [{"ip_block": {"cidr": "10.0.0.0/8"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "egress", peer_ip=None)
        assert r["status"] == "unknown"

    # ── item 2c: bare podSelector-only peer without namespace confirmation -> unknown ────────────

    def test_bare_pod_selector_without_namespace_data_is_unknown_even_when_labels_match(self):
        """K8s restricts a bare podSelector (no namespaceSelector) to the SAME namespace as the
        policy — without namespace data to confirm that, a label match alone must not become a
        confident cross-namespace `allowed`."""
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"})
        assert r["status"] == "unknown"

    def test_bare_pod_selector_different_namespace_does_not_match(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "gateway"},
                                        policy_namespace="ns-a", peer_namespace="ns-b")
        assert r["status"] == "blocked"

    def test_bare_pod_selector_label_mismatch_is_a_confident_non_match_no_namespace_needed(self):
        """When the labels themselves don't match, that's a confident non-match regardless of
        namespace data — the namespace-confirmation requirement only applies to entries that would
        otherwise match."""
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"pod_selector": {"app": "gateway"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        assert r["status"] == "blocked"

    # ── L4 finding #10c: data_available=False must yield `unknown`, never a fail-open `allowed` ──

    def test_data_unavailable_is_unknown_not_allowed(self):
        r = ad.eval_k8s_network_policy([], {"app": "orders"}, "ingress", data_available=False)
        assert r["status"] == "unknown"

    def test_data_available_true_with_empty_policies_is_genuinely_allowed(self):
        """The pre-existing, correct behavior: when the fetch DID happen and genuinely found zero
        policies, that's a real default-allow — must not regress to `unknown`."""
        r = ad.eval_k8s_network_policy([], {"app": "orders"}, "ingress", data_available=True)
        assert r["status"] == "allowed"

    # ── L2 finding #2: ipBlock.except must carve the excluded sub-range back OUT of the allow ────

    def test_ip_block_except_excludes_peer_inside_the_exception(self):
        """A peer matching the main `cidr` but ALSO matching an `except` sub-CIDR must NOT be
        reported allowed by that rule — before this fix, `except` was never read at all, so this
        peer was a false-allow."""
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"ip_block": {"cidr": "10.0.0.0/8", "except": ["10.1.0.0/16"]}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_ip="10.1.2.3")
        assert r["status"] == "blocked"

    def test_ip_block_except_still_allows_peer_outside_the_exception(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"ip_block": {"cidr": "10.0.0.0/8", "except": ["10.1.0.0/16"]}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_ip="10.2.2.3")
        assert r["status"] == "allowed"

    # ── L2 finding #2: namespaceSelector with insufficient data -> unknown, never allowed/blocked ─

    def test_namespace_selector_without_namespace_data_is_unknown(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"namespace_selector": {"team": "platform"}}]}]}]
        r = ad.eval_k8s_network_policy(policies, {"app": "orders"}, "ingress", peer_labels={"app": "other"})
        assert r["status"] == "unknown"

    def test_namespace_selector_matching_with_namespace_data_allows(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"namespace_selector": {"team": "platform"}}]}]}]
        r = ad.eval_k8s_network_policy(
            policies, {"app": "orders"}, "ingress",
            peer_namespace_labels={"team": "platform"},
        )
        assert r["status"] == "allowed"

    def test_namespace_selector_non_matching_with_namespace_data_blocks(self):
        policies = [{"pod_selector": {"app": "orders"}, "policy_types": ["ingress"], "ingress": [
            {"from": [{"namespace_selector": {"team": "platform"}}]}]}]
        r = ad.eval_k8s_network_policy(
            policies, {"app": "orders"}, "ingress",
            peer_namespace_labels={"team": "other-team"},
        )
        assert r["status"] == "blocked"


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
