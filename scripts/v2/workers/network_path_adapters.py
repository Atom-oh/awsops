"""Network Path Check — pure, read-only-data adapter evaluators.

Every function here takes already-fetched, structured AWS/K8s state (dicts/lists the orchestrator
reads from the AWS SDK or the Kubernetes API) and returns a step-result dict shaped per the design
spec's "Result semantics" contract:

    {"layer": str, "status": "allowed"|"blocked"|"unknown"|"conditional"|"not_run",
     "resource": str|None, "summary": str, "evidence": [...]}

No network/API calls happen in this module — the orchestrator (network_path.py) is the only place
that talks to boto3/K8s, so every function here is exercised by fast, deterministic, table-driven
unit tests (test_network_path_adapters.py).

Per the design spec's "Existing assets and gaps" section: `agent/lambda/reachability_read_mcp.py`'s
`check_reachability`/`_route_exists` is NOT reused here, at all — its boolean-only return has no
provenance to distinguish a genuine missing-route deny from a disclaimed-but-relevant condition it
never evaluated (TGW, prefix lists, return route, DNS), and wrapping it unchanged would produce a
false `blocked` for exactly the cases this feature's own "unsupported -> `?`, never `O`" rule exists
to prevent. This module is the "write the route evaluation from scratch" option the spec offers as
an alternative to extending that shared function. It also never calls
`agent/lambda/datasource_diag_mcp.py`'s `_test_http_connectivity` — this feature does no active
probing (see the design spec's Explicit exclusions); grep-verified by test_network_path.py.
"""
import ipaddress

_PROTO_NUM = {"tcp": "6", "udp": "17", "icmp": "1", "icmpv6": "58", "-1": "-1", "all": "-1"}
EPHEMERAL_PROBE_PORT = 49152  # one representative ephemeral port — see eval_nacl's docstring


def _proto_num(p):
    return _PROTO_NUM.get(str(p).lower(), str(p))


def _proto_matches(rule_proto, want_proto):
    rp = _proto_num(rule_proto)
    return rp == "-1" or rp == _proto_num(want_proto)


def _port_in_range(rule, port):
    if port is None:
        return True
    lo = rule.get("from_port")
    hi = rule.get("to_port")
    if lo is None and hi is None:
        return True  # protocol has no ports (e.g. -1/all, icmp without type/code filter)
    lo = -1 if lo is None else lo
    hi = 65535 if hi is None else hi
    return lo <= port <= hi


def _cidr_contains(cidr, ip):
    if not cidr or not ip:
        return False
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


# ── AWS L3/L4: Security Groups (ingress/egress, multi-SG union) ─────────────────────────────────

def eval_security_group(rules, protocol, port, peer_ip=None, peer_sg_ids=None, layer="sg"):
    """SG evaluation, written from scratch (not a wrapper around any shared boolean helper).

    `rules`: list of {"protocol": str, "from_port": int|None, "to_port": int|None,
                       "cidr": str|None, "referenced_group_id": str|None, "sg_id": str}
             — the UNION of every rule across every SG attached to the source ENI (multi-SG union
             rule, per spec Testing section). SGs are allow-list only (no explicit deny), so the
             candidate is `allowed` iff at least one rule (from ANY attached SG) matches.
    `peer_sg_ids`: SG ids attached to the peer ENI — matches a rule's `referenced_group_id`.
    """
    peer_sg_ids = set(peer_sg_ids or [])
    if peer_ip is None and not peer_sg_ids:
        # MAJOR fix: missing/unparseable peer identity must map to `unknown`, never a confident
        # `blocked` — the module's own docstring gives exactly this reasoning for not reusing
        # `check_reachability`'s boolean-only return (never invent a false verdict). Without ANY
        # peer identity, cidr rules can't be evaluated (peer_ip needed) and sg-reference rules
        # can't be evaluated (peer_sg_ids needed) — there is structurally no basis for a verdict.
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": "peer identity (peer_ip/peer_sg_ids) is missing; cannot evaluate SG rules",
            "evidence": [],
        }
    matched = None
    for rule in rules:
        if not _proto_matches(rule.get("protocol", "-1"), protocol):
            continue
        if not _port_in_range(rule, port):
            continue
        if rule.get("cidr") and _cidr_contains(rule["cidr"], peer_ip):
            matched = rule
            break
        if rule.get("referenced_group_id") and rule["referenced_group_id"] in peer_sg_ids:
            matched = rule
            break
    if matched:
        return {
            "layer": layer, "status": "allowed",
            "resource": matched.get("sg_id"),
            "summary": f"matched SG rule {matched.get('sg_id')} allowing {protocol}/{port}",
            "evidence": [matched],
        }
    return {
        "layer": layer, "status": "blocked",
        "resource": None,
        "summary": f"no SG rule allows {protocol}/{port} to/from {peer_ip or list(peer_sg_ids)}",
        "evidence": [],
    }


# ── AWS L3/L4: NACL (first-match, forward + ephemeral return) ───────────────────────────────────

def _first_match(entries, protocol, port, peer_ip=None):
    """First-match-wins by ascending rule_number, mirroring EC2 NACL evaluation order.

    MAJOR fix: entries carrying a `cidr` field are now scoped to `peer_ip` — a NACL entry allowing
    (or denying) only an unrelated CIDR must not be treated as matching every peer. An entry with NO
    `cidr` field at all is treated as unrestricted (preserves prior behavior for callers/tests that
    don't model CIDR scope), matching how EC2 NACL entries with `0.0.0.0/0` behave.
    """
    for entry in sorted(entries, key=lambda e: e["rule_number"]):
        if entry["rule_number"] >= 32767:  # implicit default-deny catch-all
            return entry
        if not _proto_matches(entry.get("protocol", "-1"), protocol):
            continue
        if not _port_in_range(entry, port):
            continue
        cidr = entry.get("cidr")
        if cidr and peer_ip and not _cidr_contains(cidr, peer_ip):
            continue
        return entry
    return None


def eval_nacl(forward_entries, return_entries, protocol, port, peer_ip=None):
    """Forward NACL rules are evaluated at the ACTUAL requested port (a definite verdict is
    possible). The return path is evaluated at a single REPRESENTATIVE ephemeral port
    (EPHEMERAL_PROBE_PORT) — per the design spec's 2026-08-19 review fix, a verdict built on that
    probe is scoped to the probed port only UNLESS the matched return rule's own port range already
    covers the full 0-65535 span (an unrestricted/wildcard rule) — in that case ANY ephemeral port
    is genuinely, unambiguously allowed, and the caveat about generalizing a narrow probe simply
    does not apply, so this can correctly return `allowed` (MAJOR fix: candidate-level `allowed`
    was structurally unreachable before this, since this layer could never emit anything but
    `blocked`/`conditional`). A return rule scoped to a narrower range (e.g. only the probed port,
    or a sub-range of the ephemeral space) still yields `conditional` — the scoped-verdict caveat
    is preserved for exactly that narrower case.
    """
    fwd = _first_match(forward_entries, protocol, port, peer_ip)
    if fwd is None or fwd.get("action") != "allow":
        return {
            "layer": "nacl", "status": "blocked",
            "resource": fwd.get("resource") if fwd else None,
            "summary": f"NACL forward rule denies {protocol}/{port}",
            "evidence": [fwd] if fwd else [],
        }
    ret = _first_match(return_entries, protocol, EPHEMERAL_PROBE_PORT, peer_ip)
    if ret is None or ret.get("action") != "allow":
        return {
            "layer": "nacl", "status": "blocked",
            "resource": ret.get("resource") if ret else None,
            "summary": f"NACL return rule denies the ephemeral probe port {EPHEMERAL_PROBE_PORT}",
            "evidence": [ret] if ret else [],
        }
    unrestricted_return = _port_in_range(ret, 0) and _port_in_range(ret, 65535)
    if unrestricted_return:
        return {
            "layer": "nacl", "status": "allowed",
            "resource": fwd.get("resource"),
            "summary": (
                f"NACL forward {protocol}/{port} allowed; return rule covers the full 0-65535 "
                "range (genuinely unrestricted, not just the probed port) — generalized allow"
            ),
            "evidence": [fwd, ret],
        }
    return {
        "layer": "nacl", "status": "conditional",
        "resource": fwd.get("resource"),
        "summary": (
            f"NACL forward {protocol}/{port} allowed; return probed only at ephemeral port "
            f"{EPHEMERAL_PROBE_PORT} (not the full ephemeral range) — scoped verdict, not a "
            "generalized allow"
        ),
        "evidence": [fwd, ret],
    }


# ── AWS L3/L4: subnet routes (longest-prefix match + blackhole), one- or two-ended ─────────────

def eval_route(route_table, dest_cidr, layer="route"):
    """Longest-prefix-match route evaluation. `route_table`: list of
    {"destination_cidr": str, "target": str, "state": "active"|"blackhole"}.

    This function requires only ONE side's route table and a destination CIDR/IP — it is the
    "one-ended, source-side-only" path the design spec requires for internet/on-premises
    destinations (no destination ENI needed), and is exactly the same function used for an
    ENI-to-ENI candidate's source-side route check. No wrapping of any ENI-to-ENI-only helper.
    """
    if dest_cidr is None:
        # MAJOR fix: missing destination must map to `unknown`, never a confident `blocked` — same
        # "never invent a false verdict" reasoning as eval_security_group's missing-peer fix.
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": "destination CIDR/IP is missing; cannot evaluate route coverage", "evidence": [],
        }
    # Normalize the destination once: a bare IP checks membership directly; a CIDR checks that it
    # is fully contained in the candidate route's network (a route can only claim a destination
    # network it fully covers).
    is_dest_network = "/" in str(dest_cidr)
    try:
        dest_net = ipaddress.ip_network(dest_cidr, strict=False) if is_dest_network else None
        dest_ip = None if is_dest_network else ipaddress.ip_address(dest_cidr)
    except ValueError:
        dest_net = dest_ip = None
    if dest_net is None and dest_ip is None:
        # MAJOR fix: malformed/unparseable destination -> `unknown`, distinct from "a genuinely
        # valid destination with no covering route" (that IS a real `blocked`, handled below).
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": f"destination {dest_cidr!r} is not a parseable IP/CIDR; cannot evaluate route coverage",
            "evidence": [],
        }

    best = None
    best_prefixlen = -1
    for r in route_table:
        try:
            net = ipaddress.ip_network(r["destination_cidr"], strict=False)
        except (ValueError, TypeError, KeyError):
            continue
        if dest_net is not None:
            contains = dest_net.network_address in net and dest_net.broadcast_address in net
        elif dest_ip is not None:
            contains = dest_ip in net
        else:
            contains = False
        if contains and net.prefixlen > best_prefixlen:
            best = r
            best_prefixlen = net.prefixlen
    if best is None:
        return {
            "layer": layer, "status": "blocked", "resource": None,
            "summary": f"no route table entry covers {dest_cidr}", "evidence": [],
        }
    if best.get("state") == "blackhole":
        return {
            "layer": layer, "status": "blocked", "resource": best.get("target"),
            "summary": f"longest-prefix route to {dest_cidr} is a blackhole ({best.get('target')})",
            "evidence": [best],
        }
    return {
        "layer": layer, "status": "allowed", "resource": best.get("target"),
        "summary": f"route to {dest_cidr} via {best.get('target')}",
        "evidence": [best],
    }


# ── AWS L3/L4: Transit Gateway (attachment / association / propagation / static / blackhole) ──

def eval_tgw(attachment_state, associated, propagation_enabled, route_entry):
    """`route_entry`: the TGW route-table entry matching the destination, or None.
    Encodes association/propagation/static-route/blackhole per spec Testing section, including an
    inability to confirm the RETURN path -> `conditional` (asymmetric-return risk), never `allowed`.
    """
    if attachment_state != "available":
        return {
            "layer": "tgw", "status": "blocked", "resource": None,
            "summary": f"TGW attachment state is {attachment_state!r}, not available", "evidence": [],
        }
    if not associated:
        return {
            "layer": "tgw", "status": "blocked", "resource": None,
            "summary": "TGW attachment is not associated with a route table", "evidence": [],
        }
    if route_entry is None:
        if propagation_enabled:
            return {
                "layer": "tgw", "status": "unknown", "resource": None,
                "summary": "propagation enabled but no matching route entry found — cache may be stale",
                "evidence": [],
            }
        return {
            "layer": "tgw", "status": "blocked", "resource": None,
            "summary": "no static or propagated route to destination in the TGW route table",
            "evidence": [],
        }
    if route_entry.get("state") == "blackhole":
        return {
            "layer": "tgw", "status": "blocked", "resource": route_entry.get("attachment_id"),
            "summary": "TGW route to destination is a blackhole", "evidence": [route_entry],
        }
    return {
        "layer": "tgw", "status": "conditional", "resource": route_entry.get("attachment_id"),
        "summary": (
            "TGW forward route confirmed; return-path route table was not independently verified "
            "(asymmetric TGW routing is possible) — scoped verdict, not a full round-trip allow"
        ),
        "evidence": [route_entry],
    }


# ── AWS L3/L4: Peering / VPN / Direct Connect boundary classification ──────────────────────────

def eval_peering(state):
    if state == "active":
        return {"layer": "peering", "status": "allowed", "resource": None,
                "summary": "VPC peering connection is active", "evidence": [{"state": state}]}
    return {"layer": "peering", "status": "blocked", "resource": None,
            "summary": f"VPC peering connection state is {state!r}", "evidence": [{"state": state}]}


def eval_vpn_or_dx(kind, aws_side_state, route_present):
    """AWS-side segment only, per spec: 'For on-premises destinations, AWSops evaluates the
    AWS-visible segment only.' The customer router/firewall side is never assertable and is not
    modeled here — the orchestrator's DNS/L7 layer records the on-prem boundary as `unknown`
    separately (see network_path.py). This function reports only the AWS-side attachment/route."""
    if aws_side_state != "up":
        return {"layer": kind, "status": "blocked", "resource": None,
                "summary": f"{kind} AWS-side state is {aws_side_state!r}", "evidence": []}
    if not route_present:
        return {"layer": kind, "status": "blocked", "resource": None,
                "summary": f"{kind} is up but no AWS-side route to destination", "evidence": []}
    return {"layer": kind, "status": "allowed", "resource": None,
            "summary": f"{kind} AWS-side segment up with a route to destination", "evidence": []}


# ── AWS L3/L4: Network Firewall ──────────────────────────────────────────────────────────────

_NFW_ALLOW = {"pass"}
_NFW_DENY = {"drop", "reject"}


def eval_network_firewall(rule_action, uninspectable=False):
    if uninspectable:
        return {"layer": "network-firewall", "status": "unknown", "resource": None,
                "summary": "matching rule form is not statically inspectable (e.g. opaque domain-list SIDs)",
                "evidence": []}
    if rule_action in _NFW_ALLOW:
        return {"layer": "network-firewall", "status": "allowed", "resource": None,
                "summary": f"Network Firewall rule action: {rule_action}", "evidence": []}
    if rule_action in _NFW_DENY:
        return {"layer": "network-firewall", "status": "blocked", "resource": None,
                "summary": f"Network Firewall rule action: {rule_action}", "evidence": []}
    return {"layer": "network-firewall", "status": "unknown", "resource": None,
            "summary": f"unrecognized Network Firewall rule action: {rule_action!r}", "evidence": []}


# ── DNS/L7: ALB listener (first-match + fixed response + target group) ─────────────────────────

def _rule_matches(condition, request):
    kind = condition.get("field")
    val = condition.get("values", [])
    req_val = request.get(kind)
    if req_val is None:
        return False
    if kind == "path-pattern":
        return any(req_val == v or (v.endswith("*") and req_val.startswith(v[:-1])) for v in val)
    return req_val in val


def eval_alb_listener(rules, request):
    """`rules`: priority-ordered list of {"priority": int, "conditions": [...], "action": {...}}.
    First matching rule wins (ALB semantics)."""
    for rule in sorted(rules, key=lambda r: r["priority"]):
        conditions = rule.get("conditions", [])
        if conditions and not all(_rule_matches(c, request) for c in conditions):
            continue
        action = rule.get("action", {})
        kind = action.get("type")
        if kind == "fixed-response":
            code = int(action.get("status_code", 200))
            status = "blocked" if code >= 400 else "allowed"
            return {"layer": "alb-listener", "status": status, "resource": f"rule/{rule['priority']}",
                    "summary": f"fixed-response {code}", "evidence": [rule]}
        if kind == "redirect":
            return {"layer": "alb-listener", "status": "conditional",
                     "resource": f"rule/{rule['priority']}",
                     "summary": "redirect action changes the destination; not evaluated further",
                     "evidence": [rule]}
        if kind == "forward":
            return {"layer": "alb-listener", "status": "allowed", "resource": f"rule/{rule['priority']}",
                    "summary": f"forward to target group {action.get('target_group_arn')}",
                    "evidence": [rule]}
        return {"layer": "alb-listener", "status": "unknown", "resource": f"rule/{rule['priority']}",
                "summary": f"unrecognized action type {kind!r}", "evidence": [rule]}
    return {"layer": "alb-listener", "status": "blocked", "resource": None,
            "summary": "no listener rule matched and no default action reached", "evidence": []}


def eval_target_group_health(healthy_target_count, total_target_count):
    if total_target_count == 0:
        return {"layer": "target-group", "status": "blocked", "resource": None,
                "summary": "target group has no registered targets", "evidence": []}
    if healthy_target_count == 0:
        return {"layer": "target-group", "status": "blocked", "resource": None,
                "summary": "target group has zero healthy targets", "evidence": []}
    if healthy_target_count < total_target_count:
        return {"layer": "target-group", "status": "conditional", "resource": None,
                "summary": f"{healthy_target_count}/{total_target_count} targets healthy",
                "evidence": []}
    return {"layer": "target-group", "status": "allowed", "resource": None,
            "summary": f"{healthy_target_count}/{total_target_count} targets healthy", "evidence": []}


# ── Kubernetes policy: NetworkPolicy (default-deny + selector match) ───────────────────────────

def _labels_match(selector, labels):
    return all(labels.get(k) == v for k, v in (selector or {}).items())


def eval_k8s_network_policy(policies, pod_labels, direction, peer_labels=None, peer_ip=None):
    """`policies`: list of {"pod_selector": {...}, "policy_types": ["Ingress","Egress"],
    "ingress"/"egress": [{"from"/"to": [{"pod_selector": {...}} | {"ip_block": {"cidr": str}}]}]}.

    K8s NetworkPolicy semantics: a pod with NO policy selecting it (for this direction) is fully
    open (`allowed`). A pod selected by >=1 policy for this direction becomes default-deny for that
    direction; it is `allowed` only if at least one rule across the selecting policies matches.
    """
    key = "ingress" if direction == "ingress" else "egress"
    # MAJOR fix (fail-open bug): the docstring's OWN documented input shape uses Kubernetes
    # canonical casing ("Ingress"/"Egress"), but this used to compare against the lowercase `key`
    # directly — with the documented shape, no policy ever selected the pod, so a default-deny pod
    # always returned `allowed`. Normalize case on both sides so canonical-cased input (the
    # documented shape) AND lowercase input are both handled correctly.
    selecting = [p for p in policies if _labels_match(p.get("pod_selector"), pod_labels)
                 and key in {str(t).lower() for t in (p.get("policy_types") or [])}]
    if not selecting:
        return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                "summary": "no NetworkPolicy selects this pod for this direction (default allow)",
                "evidence": []}
    for policy in selecting:
        for rule in policy.get(key, []):
            peers = rule.get("from" if direction == "ingress" else "to", [])
            if not peers:  # an empty peer list on a present rule means "allow all" for that rule
                return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                        "summary": "matching NetworkPolicy rule allows all peers", "evidence": [rule]}
            for peer in peers:
                if "pod_selector" in peer and peer_labels and _labels_match(peer["pod_selector"], peer_labels):
                    return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                            "summary": "matched pod_selector peer rule", "evidence": [peer]}
                if "ip_block" in peer and peer_ip and _cidr_contains(peer["ip_block"].get("cidr"), peer_ip):
                    return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                            "summary": "matched ipBlock peer rule", "evidence": [peer]}
    return {"layer": "k8s-networkpolicy", "status": "blocked", "resource": None,
            "summary": "pod is selected by >=1 NetworkPolicy for this direction; no rule matched the peer",
            "evidence": []}


# ── Kubernetes policy: Calico / Cilium / Istio — supported vs unsupported schema ───────────────

_SUPPORTED_CRD_VERSIONS = {
    "calico": {"projectcalico.org/v3"},
    "cilium": {"cilium.io/v2"},
    "istio-virtualservice": {"networking.istio.io/v1", "networking.istio.io/v1beta1"},
    "istio-destinationrule": {"networking.istio.io/v1", "networking.istio.io/v1beta1"},
    "istio-authorizationpolicy": {"security.istio.io/v1", "security.istio.io/v1beta1"},
    "istio-peerauthentication": {"security.istio.io/v1", "security.istio.io/v1beta1"},
}


def eval_mesh_policy_stub(kind, observed_api_version, crd_present):
    """Bounded stub for Calico / Cilium egress gateways / Istio VirtualService, DestinationRule,
    Gateway, AuthorizationPolicy, PeerAuthentication. This is intentionally NOT a full live policy
    evaluator (see the report: these are correctly-stubbed-`unknown`, not fully implemented) — it
    never returns `allowed`/`blocked` for a schema it cannot fully parse, satisfying the spec's
    "Unsupported versions, missing CRDs ... become `?`. They never become `O`."
    """
    layer = f"k8s-{kind}"
    if not crd_present:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": f"{kind} CRD not installed in this cluster", "evidence": []}
    supported = _SUPPORTED_CRD_VERSIONS.get(kind, set())
    if observed_api_version not in supported:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": f"unsupported {kind} apiVersion {observed_api_version!r}", "evidence": []}
    return {"layer": layer, "status": "unknown", "resource": None,
            "summary": f"{kind} policy evaluation is not implemented in this release", "evidence": []}
