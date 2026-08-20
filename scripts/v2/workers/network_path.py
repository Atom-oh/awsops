"""Network Path Check — `network_path` job (Fargate runtime; see handlers.py's REGISTRY comment on
why: Kubernetes policy evaluation + multi-account route analysis can exceed a short invocation
budget). Implements the design spec's 4 phases: resolve -> discover -> verify -> conclude
(docs/superpowers/specs/2026-08-13-network-path-check-design.md, "Worker" section).

Gating, honestly stated (L5 docs-consistency fix — the previous version of this paragraph claimed a
safety property `handlers.py` does not implement): `handlers.py`'s REGISTRY entry for
`network_path` is NOT conditional on `NETWORK_PATH_CHECK_ENABLED` — it is an unconditional
dict row, and `_network_path()` used to call straight into this module regardless of the flag.
The REAL fail-closed gates today are (a) Terraform: `network-path.tf`'s `local.npc` count is 0
unless both `workers_enabled` and `network_path_check_enabled` are true, so the worker task only
gets the `NETWORK_PATH_CHECK_ENABLED=true` env var when the feature is actually on, and (b) the web
BFF: every Network Path route calls `web/lib/network-path-gate.ts`'s fail-closed gate before a run
can even be created/enqueued. `handlers.py`'s `_network_path()` now ALSO checks the
`NETWORK_PATH_CHECK_ENABLED` env var itself before calling into this module (a second, structurally
independent gate at the dispatch site, closing the gap this docstring used to falsely claim was
already closed) — see handlers.py for that check.

`fetch_live_topology()` below is NOT implemented in this pass (raises `NotImplementedError`) — see
its own docstring. Because of that, `run()` treats ANY exception during discovery (not just
`NetworkPathError`) as a terminal `failed` run, so a real invocation — should one ever reach this
module while the feature is enabled but the fetcher is still a stub — ends in a visible `failed`
row instead of crashing uncaught and leaving `network_path_runs` stuck at `running`/`discover`.

"ADR-019 §2" citation ambiguity (L5 docs-consistency fix): code across this feature (this module,
handlers.py, reaper.py, the network_path_check migration, variables.tf) previously cited
"ADR-019 §2 register row" for `network_path_check_enabled`'s flag-gate entry. That phrase is
ambiguous — `docs/decisions/019-athena-flow-log-query-classification.md`'s OWN §2 section
("the exact same shape of pattern is already live") is about the SG-Rules Athena/CloudWatch-Logs-
Insights pattern and has nothing to do with Network Path Check. The "§2 register row" being cited
here is actually `docs/decisions/BASELINE.md`'s §2 gate/freeze register — `network_path_check_enabled`
IS one of its rows, and BASELINE.md's own ADR-019 index entry confirms ADR-019's Decision is what
classifies this flag as ordinary GATED (not FROZEN) reasoning, so ADR-019 is still the correct
GOVERNING decision — only the "§2" shorthand was pointing at the wrong document's section. Every
citation of this shape in the network-path code now reads "BASELINE.md §2 register row, governed
under ADR-019's Decision".

AI boundary (spec): this module never calls a model. It only computes the deterministic checklist.

This module deliberately never imports or calls `agent/lambda/datasource_diag_mcp.py`'s
`_test_http_connectivity` (grep-verified by test_network_path.py) — see network_path_adapters.py's
module docstring for why.
"""
import json
import time
import uuid

import network_path_adapters as ad
import network_path_reduce as reduce

# Global deadline for one run's verify phase. Kept well under typical Fargate task/SFN timeouts.
GLOBAL_DEADLINE_S = 90

# Evidence caps (spec: "Evidence is bounded and redacted before persistence").
_MAX_EVIDENCE_ITEMS = 10
_MAX_EVIDENCE_BYTES = 4_000
_REDACT_KEYS = {
    "secret", "secrets", "password", "token", "credentials", "authkey", "auth_key",
    "customerrouterconfig", "annotations",
}


class NetworkPathError(Exception):
    """Execution-level failure (spec: "Identity cannot be resolved -> run completes `failed`").
    Raised by resolve(); the caller marks the run failed WITHOUT creating any candidate rows."""


# ── Evidence redaction/bounding ──────────────────────────────────────────────────────────────────

def _redact(value):
    if isinstance(value, dict):
        return {k: ("[redacted]" if k.lower() in _REDACT_KEYS else _redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def bound_evidence(evidence):
    """Cap item count and total serialized size; redact known-sensitive keys. Never raises — a
    caller passing malformed evidence gets an empty, safe list rather than a crash mid-verify."""
    try:
        items = [_redact(e) for e in (evidence or [])][:_MAX_EVIDENCE_ITEMS]
        out = []
        total = 0
        for item in items:
            blob = json.dumps(item, default=str)
            total += len(blob)
            if total > _MAX_EVIDENCE_BYTES:
                break
            out.append(item)
        return out
    except (TypeError, ValueError):
        return []


# ── Phase 1: resolve ──────────────────────────────────────────────────────────────────────────────

def resolve_identities(definition):
    """Resolve/validate the source (Pod/Node) and destination identities declared on the check
    definition. This release resolves identity from the SAVED definition's own declared
    account/region/ENI/subnet fields (populated when the check was created against a specific
    Pod/Node/resource) rather than performing a live Kubernetes API call to re-discover a Pod's
    current IP/ENI at run time — see the report for why this is the honestly-scoped boundary for
    this pass. Raises NetworkPathError (-> run fails directly, no candidates) on anything missing.
    """
    src = definition.get("source") or {}
    dst = definition.get("destination") or {}
    req = definition.get("request") or {}

    if src.get("kind") not in ("pod", "node"):
        raise NetworkPathError(f"unsupported source kind: {src.get('kind')!r}")
    if not src.get("account_id") or not src.get("region"):
        raise NetworkPathError("source account_id/region missing")
    if not src.get("eni_id") and not src.get("subnet_id"):
        raise NetworkPathError("source could not be resolved to an ENI or subnet")

    if dst.get("kind") not in ("aws_resource", "internet", "onprem"):
        raise NetworkPathError(f"unsupported destination kind: {dst.get('kind')!r}")
    if dst["kind"] == "aws_resource" and not (dst.get("eni_id") or dst.get("cidr") or dst.get("ip")):
        raise NetworkPathError("aws_resource destination has no eni_id/cidr/ip")
    if dst["kind"] in ("internet", "onprem") and not (dst.get("ip") or dst.get("host") or dst.get("cidr")):
        raise NetworkPathError(f"{dst['kind']} destination has no ip/host/cidr")

    protocol = req.get("protocol", "tcp")
    if protocol not in ("tcp", "udp", "icmp"):
        raise NetworkPathError(f"unsupported protocol: {protocol!r}")

    return {"source": src, "destination": dst, "request": {**req, "protocol": protocol}}


# ── Phase 2: discover ────────────────────────────────────────────────────────────────────────────

def _layer_plan_for(destination_kind, topology_hint):
    """Which layers apply to a candidate, in evaluation order — a layer irrelevant to this
    candidate's destination kind is simply never in this list (never persisted as `unknown`, per
    spec: "a layer that doesn't apply to a given candidate is omitted from that candidate's step
    list rather than marked unknown")."""
    plan = ["sg", "nacl", "route"]
    if destination_kind == "aws_resource":
        if topology_hint.get("via") == "peering":
            plan.append("peering")
        elif topology_hint.get("via") == "tgw":
            plan.append("tgw")
        if topology_hint.get("via") == "alb":
            plan += ["alb-listener", "target-group"]
    elif destination_kind == "internet":
        if topology_hint.get("network_firewall"):
            plan.append("network-firewall")
        plan.append("dns")
    elif destination_kind == "onprem":
        plan.append(topology_hint.get("boundary", "vpn"))  # 'vpn' or 'dx'
        plan.append("onprem-segment")  # always `unknown` past the AWS boundary
    if topology_hint.get("k8s_network_policy"):
        plan.insert(0, "k8s-networkpolicy")
    return plan


def discover_candidates(resolved, topology):
    """`topology`: caller-supplied (production: fetched live from cached topology tables + a live
    AWS re-read of the specific candidate path, per spec's "Candidate cache and live evidence";
    tests: a fixture). Shape:

        {"candidates": [{"kind": "resolved"|"hypothesis", "via": str, "data": {...}}, ...]}

    Both ECMP and NAT Gateway candidates MUST be tagged `hypothesis` by the caller building
    `topology["candidates"]` — this function trusts the caller's `kind` rather than re-deriving it,
    because the ECMP-vs-NAT-vs-genuine-LB-redundancy distinction depends on live AWS state
    (multi-target-group health, route-table NAT Gateway target, ECMP hash) that only the topology
    fetcher has. Discovery ALWAYS produces at least one candidate; a topology fetcher that found
    nothing must supply a single degraded candidate rather than an empty list, so a genuine "no path"
    still reduces through the normal candidate machinery instead of silently returning zero evidence.
    """
    raw = topology.get("candidates") or []
    if not raw:
        raise NetworkPathError("discovery produced zero candidates")
    out = []
    for i, cand in enumerate(raw):
        kind = cand.get("kind")
        if kind not in ("resolved", "hypothesis"):
            raise NetworkPathError(f"candidate {i} has invalid kind {kind!r}")
        layer_plan = _layer_plan_for(resolved["destination"]["kind"], cand)
        out.append({
            "candidate_id": f"c{i}",
            "kind": kind,
            "layer_plan": layer_plan,
            "data": cand.get("data", {}),
            "account_id": cand.get("account_id") or resolved["source"]["account_id"],
            "region": cand.get("region") or resolved["source"]["region"],
        })
    return out


# ── Phase 3: verify ──────────────────────────────────────────────────────────────────────────────

_ADAPTER_BY_LAYER = {
    "sg": lambda data, req: ad.eval_security_group(
        data.get("sg_rules", []), req["protocol"], req.get("port"),
        peer_ip=data.get("peer_ip"), peer_sg_ids=data.get("peer_sg_ids")),
    "nacl": lambda data, req: ad.eval_nacl(
        data.get("nacl_forward", []), data.get("nacl_return", []), req["protocol"], req.get("port"),
        peer_ip=data.get("peer_ip")),
    "route": lambda data, req: ad.eval_route(data.get("route_table", []), data.get("dest_cidr")),
    "tgw": lambda data, req: ad.eval_tgw(
        data.get("attachment_state"), data.get("associated", False),
        data.get("propagation_enabled", False), data.get("route_entry")),
    "peering": lambda data, req: ad.eval_peering(data.get("state")),
    "vpn": lambda data, req: ad.eval_vpn_or_dx("vpn", data.get("aws_side_state"), data.get("route_present", False)),
    "dx": lambda data, req: ad.eval_vpn_or_dx("dx", data.get("aws_side_state"), data.get("route_present", False)),
    "network-firewall": lambda data, req: ad.eval_network_firewall(
        data.get("rule_action"), uninspectable=data.get("uninspectable", False)),
    "alb-listener": lambda data, req: ad.eval_alb_listener(data.get("rules", []), data.get("request", {})),
    "target-group": lambda data, req: ad.eval_target_group_health(
        data.get("healthy_target_count", 0), data.get("total_target_count", 0)),
    "k8s-networkpolicy": lambda data, req: ad.eval_k8s_network_policy(
        data.get("policies", []), data.get("pod_labels", {}), data.get("direction", "egress"),
        peer_labels=data.get("peer_labels"), peer_ip=data.get("peer_ip")),
    "dns": lambda data, req: {
        "layer": "dns", "status": "unknown", "resource": None,
        "summary": "DNS/L7 resolution not evaluated in this release", "evidence": [],
    },
    "onprem-segment": lambda data, req: {
        "layer": "onprem-segment", "status": "unknown", "resource": None,
        "summary": "on-premises segment past the AWS boundary is always unknown (spec Explicit exclusions)",
        "evidence": [],
    },
}

# Layers that are true bounded stubs (K8s mesh policy) route through the same shared stub evaluator.
for _kind in ("calico", "cilium", "istio-virtualservice", "istio-destinationrule", "istio-gateway",
              "istio-authorizationpolicy", "istio-peerauthentication"):
    _ADAPTER_BY_LAYER[f"k8s-{_kind}"] = (
        lambda data, req, _k=_kind: ad.eval_mesh_policy_stub(
            _k, data.get("api_version"), data.get("crd_present", False)))


def verify_candidate(candidate, request, deadline_at, now=time.monotonic):
    """Run every layer in `candidate['layer_plan']` in order, stopping (marking the rest `not_run`)
    once the global deadline is reached. One adapter's exception makes ONLY that layer `unknown` —
    per spec Error handling: "One adapter failure -> that layer is `?`; unrelated layers continue."
    Returns the list of step dicts (ordinal assigned in plan order, starting at 0).
    """
    steps = []
    deadline_hit = False
    for ordinal, layer in enumerate(candidate["layer_plan"]):
        if deadline_hit or now() >= deadline_at:
            deadline_hit = True
            steps.append({"ordinal": ordinal, "layer": layer, "status": "not_run",
                          "resource": None, "summary": "global deadline reached before this layer ran",
                          "evidence": []})
            continue
        fn = _ADAPTER_BY_LAYER.get(layer)
        if fn is None:
            steps.append({"ordinal": ordinal, "layer": layer, "status": "unknown", "resource": None,
                          "summary": f"no adapter registered for layer {layer!r}", "evidence": []})
            continue
        try:
            result = fn(candidate["data"].get(layer, {}), request)
        except Exception as e:  # noqa: BLE001 — isolate adapter failure to this one layer
            result = {"layer": layer, "status": "unknown", "resource": None,
                      "summary": f"adapter error: {e}", "evidence": []}
        result = dict(result)
        result["evidence"] = bound_evidence(result.get("evidence"))
        result["ordinal"] = ordinal
        steps.append(result)
    return steps


# ── Phase 4: conclude ────────────────────────────────────────────────────────────────────────────

def conclude(candidates_with_steps):
    """`candidates_with_steps`: [{"candidate_id","kind","steps":[{...status...}]}].
    Returns (per_candidate: [{"candidate_id","kind","status","first_blocker"}], overall_status).
    """
    per_candidate = []
    for c in candidates_with_steps:
        statuses = [s["status"] for s in c["steps"]]
        status = reduce.reduce_candidate_status(statuses)
        first_blocker = next(
            (f"{s['layer']}: {s['summary']}" for s in c["steps"] if s["status"] == "blocked"), None)
        per_candidate.append({
            "candidate_id": c["candidate_id"], "kind": c["kind"],
            "status": status, "first_blocker": first_blocker,
        })
    overall = reduce.reduce_overall_status(
        [{"kind": c["kind"], "status": c["status"]} for c in per_candidate])
    return per_candidate, overall


def build_validation_bundle(candidates_with_steps, overall_status):
    """Spec: appears iff no `X` anywhere and every AWSops-inspectable layer is `O`; any `?` layer is
    explicitly listed. AWSops never executes this bundle (Explicit exclusions) — it is operator-run
    text/commands only, and this function only ever returns descriptive strings, never runs anything.
    """
    all_steps = [s for c in candidates_with_steps for s in c["steps"]]
    if overall_status != "allowed":
        return None
    if any(s["status"] == "blocked" for s in all_steps):
        return None
    if any(s["status"] in ("conditional", "not_run") for s in all_steps):
        return None
    unknown_layers = sorted({s["layer"] for s in all_steps if s["status"] == "unknown"})
    return {
        "note": "Operator-run validation only — AWSops does not execute these commands.",
        "unknown_layers": unknown_layers,
        "suggested_checks": (
            ["Confirm the customer-managed on-premises segment separately (out of AWSops's visibility)."]
            if unknown_layers else []
        ),
    }


# ── Aurora I/O ───────────────────────────────────────────────────────────────────────────────────

def _update_phase(conn, run_id, phase):
    conn.run("UPDATE network_path_runs SET phase=:p WHERE id=:id", p=phase, id=run_id)


def _insert_candidate(conn, run_id, candidate_id, kind):
    conn.run(
        "INSERT INTO network_path_run_candidates (run_id, candidate_id, candidate_kind) "
        "VALUES (:r, :c, :k)", r=run_id, c=candidate_id, k=kind)


def _insert_steps(conn, run_id, candidate_id, account_id, region, steps):
    for s in steps:
        conn.run(
            "INSERT INTO network_path_run_steps "
            "(run_id, candidate_id, account_id, region, ordinal, layer, status, resource, summary, "
            "evidence, observed_at) "
            "VALUES (:r, :c, :a, :rg, :o, :l, :st, :res, :sum, :ev::jsonb, now())",
            r=run_id, c=candidate_id, a=account_id, rg=region, o=s["ordinal"], l=s["layer"],
            st=s["status"], res=s.get("resource"), sum=s["summary"], ev=json.dumps(s["evidence"]))


def _update_candidate_result(conn, run_id, candidate_id, status, first_blocker):
    conn.run(
        "UPDATE network_path_run_candidates SET status=:s, first_blocker=:fb "
        "WHERE run_id=:r AND candidate_id=:c",
        s=status, fb=first_blocker, r=run_id, c=candidate_id)


def _finish_run(conn, run_id, status, overall_status=None, validation_bundle=None):
    conn.run(
        "UPDATE network_path_runs SET status=:s, overall_status=:os, validation_bundle=:vb::jsonb, "
        "finished_at=now() WHERE id=:id",
        s=status, os=overall_status,
        vb=(json.dumps(validation_bundle) if validation_bundle is not None else None), id=run_id)


def fetch_live_topology(resolved):  # pragma: no cover — thin AWS-calling boundary, not unit tested
    """Production topology fetcher: reads cached `topology_nodes`/`topology_edges` for candidate
    paths, then re-reads SG/NACL/routes/TGW/VPN/DX/Network Firewall/ELBv2/K8s policy live for the
    specific candidate (spec: "Aurora topology is a candidate-path accelerator, not final
    authority"). Not implemented in this pass — see the report. Tests inject a fixture topology
    directly into discover_candidates()/run() instead of exercising this function.
    """
    raise NotImplementedError(
        "fetch_live_topology: live AWS/topology-table reads are not implemented in this pass; "
        "see the report for scope")


def run(payload, conn, topology_fetcher=fetch_live_topology, deadline_s=GLOBAL_DEADLINE_S,
        now=time.monotonic):
    """Entry point registered in handlers.py's REGISTRY. `payload`: {"run_id", "definition"}
    (definition = the run's `definition_snapshot`, already immutable per spec)."""
    run_id = payload["run_id"]
    definition = payload["definition"]

    try:
        resolved = resolve_identities(definition)
    except NetworkPathError as e:
        _finish_run(conn, run_id, "failed", overall_status="failed")
        return {"run_id": run_id, "status": "failed", "error": str(e)}

    _update_phase(conn, run_id, "discover")
    try:
        topology = topology_fetcher(resolved)
        candidates = discover_candidates(resolved, topology)
    except NetworkPathError as e:
        _finish_run(conn, run_id, "failed", overall_status="failed")
        return {"run_id": run_id, "status": "failed", "error": str(e)}
    except Exception as e:  # noqa: BLE001 — MAJOR fix: fetch_live_topology is unimplemented in
        # this pass (raises NotImplementedError) and any other unexpected fetcher failure must also
        # terminate the run visibly rather than crash uncaught and leave network_path_runs stuck at
        # running/discover until the reaper eventually flips it minutes later.
        _finish_run(conn, run_id, "failed", overall_status="failed")
        return {"run_id": run_id, "status": "failed", "error": f"{type(e).__name__}: {e}"}

    for c in candidates:
        _insert_candidate(conn, run_id, c["candidate_id"], c["kind"])

    _update_phase(conn, run_id, "verify")
    deadline_at = now() + deadline_s
    candidates_with_steps = []
    for c in candidates:
        steps = verify_candidate(c, resolved["request"], deadline_at, now=now)
        _insert_steps(conn, run_id, c["candidate_id"], c["account_id"], c["region"], steps)
        candidates_with_steps.append({"candidate_id": c["candidate_id"], "kind": c["kind"], "steps": steps})

    _update_phase(conn, run_id, "conclude")
    per_candidate, overall_status = conclude(candidates_with_steps)
    for pc in per_candidate:
        _update_candidate_result(conn, run_id, pc["candidate_id"], pc["status"], pc["first_blocker"])
    bundle = build_validation_bundle(candidates_with_steps, overall_status)
    _finish_run(conn, run_id, "succeeded", overall_status=overall_status, validation_bundle=bundle)

    return {"run_id": run_id, "status": "succeeded", "overall_status": overall_status,
            "candidates": len(candidates)}
