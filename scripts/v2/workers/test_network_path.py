"""Orchestration tests for network_path.py — resolve/discover/verify/conclude, deadline behavior,
multi-candidate independence, evidence redaction, PK-collision safety, and the grep-verifiable
`_test_http_connectivity`-never-called invariant."""
import glob
import json
import os

import pytest

import network_path as np
import network_path_adapters as ad


class FakeConn:
    def __init__(self):
        self.calls = []

    def run(self, sql, **kwargs):
        self.calls.append((sql, kwargs))
        return []

    def inserted_steps(self):
        return [c[1] for c in self.calls if "INSERT INTO network_path_run_steps" in c[0]]

    def inserted_candidates(self):
        return [c[1] for c in self.calls if "INSERT INTO network_path_run_candidates" in c[0]]

    def candidate_updates(self):
        return [c[1] for c in self.calls if "UPDATE network_path_run_candidates" in c[0]]

    def run_finishes(self):
        return [c[1] for c in self.calls if "UPDATE network_path_runs SET status" in c[0]]


def _definition(dest_kind="aws_resource", via="direct"):
    return {
        "source": {"kind": "pod", "account_id": "111111111111", "region": "ap-northeast-2",
                    "eni_id": "eni-src"},
        "destination": {"kind": dest_kind, "eni_id": "eni-dst", "cidr": "10.0.2.0/24",
                          "ip": "203.0.113.10", "host": "example.com"},
        "request": {"protocol": "tcp", "port": 443},
    }


def _topology_one_candidate(kind="resolved", via="direct", sg_allowed=True):
    sg_rules = [{"sg_id": "sg-1", "protocol": "tcp", "from_port": 443, "to_port": 443,
                 "cidr": "0.0.0.0/0" if sg_allowed else "192.168.0.0/16"}]
    return {"candidates": [{
        "kind": kind, "via": via,
        "data": {
            "sg": {"sg_rules": sg_rules, "peer_ip": "10.0.2.5"},
            "nacl": {"nacl_forward": [{"rule_number": 100, "protocol": "-1", "action": "allow"}],
                     "nacl_return": [{"rule_number": 100, "protocol": "-1", "action": "allow"}]},
            "route": {"route_table": [{"destination_cidr": "10.0.2.0/24", "target": "local",
                                         "state": "active"}], "dest_cidr": "10.0.2.0/24"},
        },
    }]}


# ── resolve ──────────────────────────────────────────────────────────────────────────────────────

class TestResolve:
    def test_missing_source_account_raises(self):
        d = _definition()
        d["source"].pop("account_id")
        with pytest.raises(np.NetworkPathError):
            np.resolve_identities(d)

    def test_unsupported_source_kind_raises(self):
        d = _definition()
        d["source"]["kind"] = "service"
        with pytest.raises(np.NetworkPathError):
            np.resolve_identities(d)

    def test_valid_definition_resolves(self):
        resolved = np.resolve_identities(_definition())
        assert resolved["source"]["eni_id"] == "eni-src"

    def test_resolve_failure_run_completes_failed_directly(self):
        conn = FakeConn()
        d = _definition()
        d["source"].pop("account_id")
        result = np.run({"run_id": "r1", "definition": d}, conn)
        assert result["status"] == "failed"
        # No candidates were ever created — global failure bypasses per-candidate reduction.
        assert conn.inserted_candidates() == []
        finishes = conn.run_finishes()
        assert finishes[-1]["s"] == "failed"
        assert finishes[-1]["os"] == "failed"
        # MINOR fix: the error text must actually be persisted to network_path_runs.error, not
        # just returned in run()'s in-memory result (which the caller/reaper never see again).
        assert finishes[-1]["err"] == result["error"]
        assert "account_id" in finishes[-1]["err"]


# ── discover ─────────────────────────────────────────────────────────────────────────────────────

class TestDiscover:
    def test_zero_candidates_raises(self):
        resolved = np.resolve_identities(_definition())
        with pytest.raises(np.NetworkPathError):
            np.discover_candidates(resolved, {"candidates": []})

    def test_invalid_kind_raises(self):
        resolved = np.resolve_identities(_definition())
        with pytest.raises(np.NetworkPathError):
            np.discover_candidates(resolved, {"candidates": [{"kind": "maybe"}]})

    def test_irrelevant_layer_omitted_not_marked_unknown(self):
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        candidates = np.discover_candidates(resolved, _topology_one_candidate())
        # A direct aws_resource candidate never gets a peering/tgw/vpn/dx/onprem-segment layer.
        plan = candidates[0]["layer_plan"]
        assert "peering" not in plan
        assert "tgw" not in plan
        assert "onprem-segment" not in plan

    def test_onprem_destination_gets_boundary_and_segment_layers(self):
        resolved = np.resolve_identities(_definition(dest_kind="onprem"))
        topo = _topology_one_candidate()
        topo["candidates"][0]["boundary"] = "dx"
        candidates = np.discover_candidates(resolved, topo)
        assert "dx" in candidates[0]["layer_plan"]
        assert "onprem-segment" in candidates[0]["layer_plan"]

    def test_k8s_destination_wires_in_every_mesh_stub_layer(self):
        """L4 finding #12: the mesh-policy layers (Calico/Cilium/Istio) were registered in
        `_ADAPTER_BY_LAYER` but `_layer_plan_for` never inserted them into any candidate's plan —
        they could never even run (not even to record `unknown`). Whenever the k8s_network_policy
        hint is set, every mesh layer must now appear in the plan too."""
        resolved = np.resolve_identities(_definition())
        topo = _topology_one_candidate()
        topo["candidates"][0]["k8s_network_policy"] = True
        candidates = np.discover_candidates(resolved, topo)
        plan = candidates[0]["layer_plan"]
        assert "k8s-networkpolicy" in plan
        for layer in np._MESH_LAYERS:
            assert layer in plan

    # ── L4 finding #13 (cheap mitigation): destination-side SG/NACL second pass ──────────────────

    def test_dest_eni_known_adds_destination_side_sg_and_nacl_layers(self):
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        topo = _topology_one_candidate()
        topo["candidates"][0]["dest_eni_known"] = True
        candidates = np.discover_candidates(resolved, topo)
        plan = candidates[0]["layer_plan"]
        assert "sg-dst" in plan
        assert "nacl-dst" in plan

    def test_dest_eni_unknown_omits_destination_side_layers(self):
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        candidates = np.discover_candidates(resolved, _topology_one_candidate())
        plan = candidates[0]["layer_plan"]
        assert "sg-dst" not in plan
        assert "nacl-dst" not in plan

    def test_dest_side_sg_block_produces_a_distinct_blocked_step(self):
        """A destination-side SG that denies the traffic must surface as its OWN `sg-dst` blocked
        step — independent from (and even when) the source-side `sg` step is allowed."""
        resolved = np.resolve_identities(_definition(dest_kind="aws_resource"))
        topo = _topology_one_candidate(sg_allowed=True)  # source-side sg: allowed
        topo["candidates"][0]["dest_eni_known"] = True
        topo["candidates"][0]["data"]["sg-dst"] = {
            "sg_rules": [{"sg_id": "sg-dst-1", "protocol": "tcp", "from_port": 22, "to_port": 22,
                          "cidr": "0.0.0.0/0"}],
            "peer_ip": "10.0.1.5",
        }
        topo["candidates"][0]["data"]["nacl-dst"] = topo["candidates"][0]["data"]["nacl"]
        candidates = np.discover_candidates(resolved, topo)
        deadline_at = np.time.monotonic() + 60
        steps = np.verify_candidate(candidates[0], resolved["request"], deadline_at)
        sg_step = next(s for s in steps if s["layer"] == "sg")
        sg_dst_step = next(s for s in steps if s["layer"] == "sg-dst")
        assert sg_step["status"] == "allowed"
        assert sg_dst_step["status"] == "blocked"  # port 443 not in the dest-side sg-dst-1 rule (22 only)

    def test_non_k8s_destination_never_gets_mesh_layers(self):
        resolved = np.resolve_identities(_definition())
        candidates = np.discover_candidates(resolved, _topology_one_candidate())
        plan = candidates[0]["layer_plan"]
        for layer in np._MESH_LAYERS:
            assert layer not in plan

    def test_mesh_layers_run_as_unknown_never_fabricating_allowed_or_blocked(self):
        """Each mesh layer is still a bounded stub (`eval_mesh_policy_stub`) — wiring it in must
        make it VISIBLE as `unknown`, never a confident allowed/blocked."""
        resolved = np.resolve_identities(_definition())
        topo = _topology_one_candidate()
        topo["candidates"][0]["k8s_network_policy"] = True
        candidates = np.discover_candidates(resolved, topo)
        deadline_at = np.time.monotonic() + 60
        steps = np.verify_candidate(candidates[0], resolved["request"], deadline_at)
        mesh_steps = [s for s in steps if s["layer"] in np._MESH_LAYERS]
        assert len(mesh_steps) == len(np._MESH_LAYERS)
        assert all(s["status"] == "unknown" for s in mesh_steps)


# ── verify: deadline / adapter isolation ────────────────────────────────────────────────────────

class TestVerify:
    def test_adapter_exception_isolated_to_one_layer(self):
        candidate = {"candidate_id": "c0", "kind": "resolved",
                     "layer_plan": ["sg", "route"],
                     "data": {"sg": {"sg_rules": "not-a-list-will-not-error-but-force-bad-data"},
                               "route": {"route_table": [{"destination_cidr": "10.0.0.0/8",
                                                            "target": "local", "state": "active"}],
                                          "dest_cidr": "10.0.0.5"}}}
        # Force the sg adapter to raise by handing it a non-iterable-of-dicts value via monkeypatch
        orig = ad.eval_security_group

        def boom(*a, **k):
            raise RuntimeError("boom")
        ad.eval_security_group = boom
        try:
            steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=1e18)
        finally:
            ad.eval_security_group = orig
        assert steps[0]["status"] == "unknown"
        assert "boom" in steps[0]["summary"]
        assert steps[1]["status"] == "allowed"  # route layer unaffected

    def test_deadline_truncation_marks_remaining_not_run(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["sg", "nacl", "route"],
                     "data": _topology_one_candidate()["candidates"][0]["data"]}
        # deadline already passed -> every layer is not_run
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=-1)
        assert all(s["status"] == "not_run" for s in steps)

    def test_partial_deadline_first_layer_runs_rest_not_run(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["sg", "nacl", "route"],
                     "data": _topology_one_candidate()["candidates"][0]["data"]}
        clock = iter([0, 10])  # first check passes (0 < 5), second check fails (10 >= 5)

        def fake_now():
            return next(clock, 999)
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=5, now=fake_now)
        assert steps[0]["status"] != "not_run"
        assert steps[1]["status"] == "not_run"
        assert steps[2]["status"] == "not_run"

    def test_evidence_is_bounded_and_redacted(self):
        candidate = {"candidate_id": "c0", "kind": "resolved", "layer_plan": ["sg"],
                     "data": {"sg": {"sg_rules": [{"sg_id": "sg-1", "protocol": "-1",
                                                     "cidr": "0.0.0.0/0", "password": "shh"}],
                                       "peer_ip": "1.2.3.4"}}}
        steps = np.verify_candidate(candidate, {"protocol": "tcp", "port": 443}, deadline_at=1e18)
        evidence = steps[0]["evidence"]
        assert evidence
        assert evidence[0].get("password") == "[redacted]"

    def test_evidence_item_count_capped(self):
        big_evidence = [{"i": i} for i in range(50)]
        bounded = np.bound_evidence(big_evidence)
        assert len(bounded) <= np._MAX_EVIDENCE_ITEMS

    def test_evidence_byte_size_capped(self):
        big_evidence = [{"blob": "x" * 10_000}]
        bounded = np.bound_evidence(big_evidence)
        assert len(bounded) == 0  # single item already exceeds the byte cap


# ── conclude ─────────────────────────────────────────────────────────────────────────────────────

class TestConclude:
    def test_multiple_candidates_independent_status(self):
        candidates = [
            {"candidate_id": "c0", "kind": "resolved",
             "steps": [{"layer": "sg", "status": "allowed", "summary": "ok"}]},
            {"candidate_id": "c1", "kind": "resolved",
             "steps": [{"layer": "sg", "status": "blocked", "summary": "denied"}]},
        ]
        per_candidate, overall = np.conclude(candidates)
        assert per_candidate[0]["status"] == "allowed"
        assert per_candidate[1]["status"] == "blocked"
        assert per_candidate[1]["first_blocker"] is not None
        assert overall == "conditional"  # disagreement among resolved candidates

    def test_validation_bundle_only_when_no_x_and_all_o(self):
        candidates = [{"candidate_id": "c0", "kind": "resolved",
                        "steps": [{"layer": "sg", "status": "allowed", "summary": "ok"}]}]
        bundle = np.build_validation_bundle(candidates, "allowed")
        assert bundle is not None

    def test_validation_bundle_absent_when_blocked(self):
        candidates = [{"candidate_id": "c0", "kind": "resolved",
                        "steps": [{"layer": "sg", "status": "blocked", "summary": "no"}]}]
        assert np.build_validation_bundle(candidates, "blocked") is None

    def test_validation_bundle_absent_when_conditional_layer_present(self):
        candidates = [{"candidate_id": "c0", "kind": "resolved",
                        "steps": [{"layer": "nacl", "status": "conditional", "summary": "scoped"}]}]
        assert np.build_validation_bundle(candidates, "conditional") is None

    def test_validation_bundle_lists_unknown_layers(self):
        candidates = [{"candidate_id": "c0", "kind": "resolved", "steps": [
            {"layer": "sg", "status": "allowed", "summary": "ok"},
            {"layer": "dns", "status": "unknown", "summary": "not evaluated"},
        ]}]
        bundle = np.build_validation_bundle(candidates, "allowed")
        assert bundle is not None
        assert "dns" in bundle["unknown_layers"]


# ── full run(): PK collision safety, multi-candidate persistence ───────────────────────────────

class TestFullRun:
    def test_two_candidates_no_pk_collision_at_same_ordinal(self):
        conn = FakeConn()
        resolved_definition = _definition()

        def two_candidate_topology(_resolved):
            topo = _topology_one_candidate()
            topo["candidates"].append(dict(topo["candidates"][0]))
            return topo

        result = np.run({"run_id": "run-1", "definition": resolved_definition}, conn,
                         topology_fetcher=two_candidate_topology)
        assert result["status"] == "succeeded"
        steps = conn.inserted_steps()
        # Both candidates wrote a step at ordinal 0 — distinguished by candidate_id, no collision.
        ordinal_zero = [s for s in steps if s["o"] == 0]
        assert len(ordinal_zero) == 2
        assert {s["c"] for s in ordinal_zero} == {"c0", "c1"}

    def test_run_succeeds_and_writes_overall_status(self):
        conn = FakeConn()
        result = np.run({"run_id": "run-2", "definition": _definition()}, conn,
                         topology_fetcher=lambda r: _topology_one_candidate())
        assert result["status"] == "succeeded"
        # MAJOR fix (2026-08-19+ review): the fixture's NACL forward+return rules are genuinely
        # unrestricted (protocol "-1", no port scoping at all) — with eval_nacl's fix, this is no
        # longer force-capped at `conditional`; it correctly reaches `allowed`. This is the
        # end-to-end proof that candidate-level `allowed` (and the validation bundle) ARE reachable
        # through the real run() path — not just hand-fed into build_validation_bundle() directly.
        assert result["overall_status"] == "allowed"
        finishes = conn.run_finishes()
        assert finishes[-1]["s"] == "succeeded"
        assert finishes[-1]["os"] == "allowed"
        assert finishes[-1]["vb"] is not None  # validation bundle is populated, not dead code
        bundle = json.loads(finishes[-1]["vb"])
        assert bundle["unknown_layers"] == []  # sg/nacl/route are all inspectable and allowed here


    def test_unimplemented_topology_fetcher_ends_in_terminal_failed_not_a_crash(self):
        """MAJOR fix: fetch_live_topology() (the real default) raises NotImplementedError — run()
        must not let that escape uncaught (which would leave network_path_runs stuck at
        running/discover); it must be caught and turned into a terminal `failed` run, same as a
        NetworkPathError."""
        conn = FakeConn()
        result = np.run({"run_id": "run-3", "definition": _definition()}, conn)  # default fetcher
        assert result["status"] == "failed"
        assert "NotImplementedError" in result["error"]
        finishes = conn.run_finishes()
        assert finishes[-1]["s"] == "failed"
        assert finishes[-1]["os"] == "failed"
        assert conn.inserted_candidates() == []  # discovery never got far enough to write candidates
        assert finishes[-1]["err"] == result["error"]  # MINOR fix: error text is now persisted


# ── grep-verifiable: never calls the SSRF-risk active-probe helper ─────────────────────────────

def test_never_calls_test_http_connectivity():
    # The name may appear in a comment/docstring explaining that it's NOT used (as it does in
    # network_path_adapters.py's module docstring) — what must never appear is an actual CALL.
    targets = glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "network_path*.py"))
    assert targets
    for path in targets:
        if os.path.basename(path).startswith("test_"):
            continue
        with open(path, encoding="utf-8") as f:
            src = f.read()
        assert "_test_http_connectivity(" not in src, path
