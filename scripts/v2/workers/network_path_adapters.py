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
import re

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


def _is_valid_ip(ip):
    """MINOR fix: the partial-peer guards below key only on `peer_ip is None` — a PRESENT-BUT-
    MALFORMED `peer_ip` string (not a valid IPv4/IPv6 literal) used to fall through to
    `_cidr_contains`, which swallows the `ValueError` and returns a plain `False`, i.e. an ordinary
    non-match. That let a failed identity PARSE (as opposed to a genuinely missing one) still
    produce a confident `blocked`/non-match verdict instead of `unknown`. Callers must treat a
    malformed `peer_ip` exactly like `peer_ip is None` for gating purposes."""
    if ip is None:
        return False
    try:
        ipaddress.ip_address(ip)
        return True
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
    # MINOR fix: `peer_sg_ids=None` (resolution failed/unknown) and `peer_sg_ids=[]` (resolution
    # SUCCEEDED — the peer legitimately has zero SGs) are different signals; collapsing both into
    # the same falsy empty set below (as the pre-fix code did at every check site) treated a
    # confident "peer has no SGs, so no sg-reference rule can match" the same as "we don't know the
    # peer's SGs" — the latter must stay `unknown`/unevaluable, the former is a legitimate
    # confident non-match. `peer_sg_ids_unresolved` captures the ORIGINAL None-ness before it's
    # normalized to a set for membership checks.
    peer_sg_ids_unresolved = peer_sg_ids is None
    peer_sg_ids = set(peer_sg_ids or [])
    # MINOR fix: a present-but-malformed `peer_ip` (not a valid IP literal) must be treated the
    # same as a missing one — a failed parse is not evidence of anything, and letting it reach
    # `_cidr_contains` below (which silently swallows the ValueError as a plain non-match) could
    # yield a confident `blocked` from bad data rather than `unknown`.
    peer_ip_usable = peer_ip is not None and _is_valid_ip(peer_ip)
    if not peer_ip_usable:
        peer_ip = None
    if peer_ip is None and peer_sg_ids_unresolved:
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
    # Follow-up fix (item 9): a PARTIAL peer identity (e.g. peer_sg_ids known but peer_ip missing,
    # or vice versa) leaves an entire class of rule unevaluable rather than the whole call. Track
    # whether any proto/port-eligible rule couldn't be checked because its OWN peer kind's data is
    # missing — if nothing confidently matches AND such a rule existed, the verdict must be
    # `unknown`, not a confident `blocked` (only the fully-missing-everything case above was
    # guarded before this fix).
    had_unevaluable_rule = False
    for rule in rules:
        if not _proto_matches(rule.get("protocol", "-1"), protocol):
            continue
        if not _port_in_range(rule, port):
            continue
        cidr = rule.get("cidr")
        if cidr:
            if peer_ip is None:
                had_unevaluable_rule = True
            elif _cidr_contains(cidr, peer_ip):
                matched = rule
                break
        ref_group = rule.get("referenced_group_id")
        if ref_group:
            if peer_sg_ids_unresolved:
                had_unevaluable_rule = True
            elif ref_group in peer_sg_ids:
                matched = rule
                break
    if matched:
        return {
            "layer": layer, "status": "allowed",
            "resource": matched.get("sg_id"),
            "summary": f"matched SG rule {matched.get('sg_id')} allowing {protocol}/{port}",
            "evidence": [matched],
        }
    if had_unevaluable_rule:
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": (
                f"one or more SG rules for {protocol}/{port} could not be evaluated due to partial "
                "missing peer data (a CIDR rule with no peer_ip, or an SG-reference rule with no "
                "peer_sg_ids) and no rule confidently matched"
            ),
            "evidence": [],
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

    Follow-up fix (item 1): when the FIRST proto/port-eligible entry encountered carries a `cidr`
    field but `peer_ip` is unavailable, this function cannot tell whether that entry would actually
    match — under first-match-wins semantics it is structurally wrong to either (a) skip past it and
    let a LATER, unrelated entry win, or (b) let it win regardless of its CIDR scope (the bug this
    was reported against: the old code did exactly (b), since `peer_ip` was falsy and short-circuited
    the CIDR check away entirely). Returns `(entry, ambiguous)` — `ambiguous=True` means resolution
    genuinely cannot proceed past this position without `peer_ip`; the caller must surface `unknown`,
    never invent a confident verdict from either side of that entry.
    """
    # MINOR fix: a present-but-malformed `peer_ip` must be treated the same as a missing one — see
    # `_is_valid_ip`'s docstring for why (a failed parse falls through to `_cidr_contains`'s
    # swallowed-ValueError non-match otherwise, which is indistinguishable from a genuine miss).
    if peer_ip is not None and not _is_valid_ip(peer_ip):
        peer_ip = None
    for entry in sorted(entries, key=lambda e: e["rule_number"]):
        if entry["rule_number"] >= 32767:  # implicit default-deny catch-all
            return entry, False
        if not _proto_matches(entry.get("protocol", "-1"), protocol):
            continue
        if not _port_in_range(entry, port):
            continue
        cidr = entry.get("cidr")
        if cidr:
            if peer_ip is None:
                # Cannot determine whether this entry (the first eligible one, evaluated in
                # ascending rule_number order) matches — first-match-wins means we cannot safely
                # skip it either, since a real peer_ip might have matched it here.
                return None, True
            if not _cidr_contains(cidr, peer_ip):
                continue
        return entry, False
    return None, False


def eval_nacl(forward_entries, return_entries, protocol, port, peer_ip=None, layer="nacl"):
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

    `layer` (default "nacl") lets a caller reuse this SAME function for a second, DESTINATION-side
    evaluation pass (L4 finding #13's cheap mitigation — see network_path.py's `_layer_plan_for`
    "sg-dst"/"nacl-dst" wiring) without the two passes' steps colliding under one layer name.
    """
    fwd, fwd_ambiguous = _first_match(forward_entries, protocol, port, peer_ip)
    if fwd_ambiguous:
        # Follow-up fix (item 1): the first proto/port-eligible forward entry is CIDR-scoped but
        # peer_ip is missing — first-match-wins cannot be resolved past it, so this must not
        # silently let a later entry (or an implicit assumption) decide a confident verdict.
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": (
                "a NACL forward entry scoped to a CIDR could not be evaluated because peer_ip is "
                "missing; cannot confidently determine allow/deny for this entry"
            ),
            "evidence": [],
        }
    if fwd is None or fwd.get("action") != "allow":
        return {
            "layer": layer, "status": "blocked",
            "resource": fwd.get("resource") if fwd else None,
            "summary": f"NACL forward rule denies {protocol}/{port}",
            "evidence": [fwd] if fwd else [],
        }
    ret, ret_ambiguous = _first_match(return_entries, protocol, EPHEMERAL_PROBE_PORT, peer_ip)
    if ret_ambiguous:
        return {
            "layer": layer, "status": "unknown", "resource": None,
            "summary": (
                "a NACL return entry scoped to a CIDR could not be evaluated because peer_ip is "
                "missing; cannot confidently determine the return path"
            ),
            "evidence": [fwd],
        }
    if ret is None:
        return {
            "layer": layer, "status": "blocked",
            "resource": None,
            "summary": f"NACL return rule denies the ephemeral probe port {EPHEMERAL_PROBE_PORT}",
            "evidence": [],
        }
    if ret.get("action") != "allow":
        # MAJOR fix (L4 finding #10, asymmetric with the allow-side fix above): a DENY that matched
        # only because it happened to cover the single probed ephemeral port must not generalize to
        # a confident `blocked` — a different ephemeral port might still be allowed. Only a deny
        # whose OWN port range already spans the full 0-65535 ephemeral space (genuinely
        # unrestricted — e.g. the implicit default-deny catch-all, or an explicit wildcard deny)
        # can confidently produce `blocked`; a deny scoped to a narrower range yields `conditional`,
        # matching the allow side's "generalize only when genuinely unrestricted" rule.
        unrestricted_deny = _port_in_range(ret, 0) and _port_in_range(ret, 65535)
        if unrestricted_deny:
            return {
                "layer": layer, "status": "blocked",
                "resource": ret.get("resource"),
                "summary": (
                    f"NACL return rule denies the ephemeral probe port {EPHEMERAL_PROBE_PORT}; "
                    "deny covers the full 0-65535 range (genuinely unrestricted) — generalized deny"
                ),
                "evidence": [ret],
            }
        return {
            "layer": layer, "status": "conditional",
            "resource": ret.get("resource"),
            "summary": (
                f"NACL return rule denies only the probed ephemeral port {EPHEMERAL_PROBE_PORT} "
                "(not the full ephemeral range) — a different ephemeral port may still be allowed; "
                "scoped verdict, not a generalized block"
            ),
            "evidence": [fwd, ret],
        }
    unrestricted_return = _port_in_range(ret, 0) and _port_in_range(ret, 65535)
    if unrestricted_return:
        return {
            "layer": layer, "status": "allowed",
            "resource": fwd.get("resource"),
            "summary": (
                f"NACL forward {protocol}/{port} allowed; return rule covers the full 0-65535 "
                "range (genuinely unrestricted, not just the probed port) — generalized allow"
            ),
            "evidence": [fwd, ret],
        }
    return {
        "layer": layer, "status": "conditional",
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

def _glob_match(req_val, patterns):
    """`*` glob semantics — used by BOTH `path-pattern` and `host-header` conditions, matching
    ALB's actual behavior for either field (L2 finding #5c: host-header wildcards like
    `*.example.com` never matched anything before, since only path-pattern implemented `*`)."""
    for v in patterns:
        if req_val == v:
            return True
        if "*" not in v and "?" not in v:
            continue
        # ALB's own glob semantics: `*` matches 0+ chars, `?` matches exactly 1 char. Translate to
        # a regex anchored on the whole value (fnmatch-equivalent, but explicit and dependency-free).
        pattern = "^" + "".join(
            ".*" if ch == "*" else "." if ch == "?" else re.escape(ch) for ch in v
        ) + "$"
        if re.match(pattern, req_val):
            return True
    return False


def _rule_matches(condition, request):
    kind = condition.get("field")
    val = condition.get("values", [])
    req_val = request.get(kind)
    if req_val is None:
        return False
    if kind in ("path-pattern", "host-header"):
        return _glob_match(req_val, val)
    return req_val in val


def _priority_sort_key(rule):
    """ALB's real `default` action carries the literal priority value `"default"` (a string, per
    ELBv2's own API contract) — `sorted(rules, key=priority)` crashed comparing int to str. Treat
    `"default"` as sorting LAST (infinite priority): every numbered rule is evaluated first, and the
    default action — which ALWAYS exists on a real listener — is the final fallback, never crashing
    (L2 finding #5b)."""
    p = rule.get("priority")
    if p == "default":
        return float("inf")
    try:
        return float(p)
    except (TypeError, ValueError):
        return float("inf")


def eval_alb_listener(rules, request):
    """`rules`: priority-ordered list of {"priority": int|"default", "conditions": [...],
    "action": {...}}. First matching rule wins (ALB semantics); `"default"` (ELBv2's own literal
    priority value for the listener's always-present default action) sorts last.

    L2 finding #5a: a real ALB listener ALWAYS has a default action — a rule set that omits it is
    MISSING DATA (an incomplete describe/fixture), not a genuine "nothing matched, traffic denied"
    outcome. Falling through the whole rule list without ever hitting a `priority == "default"` row
    must therefore return `unknown`, never a confident `blocked` (matching the same "missing data
    never yields a confident deny" fix already applied to eval_security_group/eval_route)."""
    has_default = any(r.get("priority") == "default" for r in rules)
    for rule in sorted(rules, key=_priority_sort_key):
        conditions = rule.get("conditions", [])
        if conditions and not all(_rule_matches(c, request) for c in conditions):
            continue
        action = rule.get("action", {})
        kind = action.get("type")
        label = f"rule/{rule['priority']}"
        if kind == "fixed-response":
            code = int(action.get("status_code", 200))
            status = "blocked" if code >= 400 else "allowed"
            return {"layer": "alb-listener", "status": status, "resource": label,
                    "summary": f"fixed-response {code}", "evidence": [rule]}
        if kind == "redirect":
            return {"layer": "alb-listener", "status": "conditional", "resource": label,
                     "summary": "redirect action changes the destination; not evaluated further",
                     "evidence": [rule]}
        if kind == "forward":
            return {"layer": "alb-listener", "status": "allowed", "resource": label,
                    "summary": f"forward to target group {action.get('target_group_arn')}",
                    "evidence": [rule]}
        return {"layer": "alb-listener", "status": "unknown", "resource": label,
                "summary": f"unrecognized action type {kind!r}", "evidence": [rule]}
    if not has_default:
        return {
            "layer": "alb-listener", "status": "unknown", "resource": None,
            "summary": "no listener rule matched and no default action is present in the input "
                       "(a real ALB listener always has one — this is missing data, not a confirmed deny)",
            "evidence": [],
        }
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


def _policy_type_applies(policy, direction):
    """Kubernetes' REAL `policyTypes`-defaulting semantics (L4 finding #10a): when `policy_types`
    is genuinely absent from the policy (not merely an empty list — an explicit `[]` is NOT the
    same as "key omitted" and is treated as "selects nothing", matching the K8s API), the default
    is `[Ingress]`, PLUS `Egress` whenever the policy's own `egress` key is present at all (even
    with zero rules — presence of the field, not the rule COUNT, is what triggers the K8s
    apiserver's default). When `policy_types` IS present, only that explicit (case-insensitive) list
    matters — no defaulting applies."""
    pts = policy.get("policy_types")
    if pts is not None:
        want = "ingress" if direction == "ingress" else "egress"
        return want in {str(t).lower() for t in pts}
    if direction == "ingress":
        return True  # K8s default: Ingress always applies when policyTypes is omitted entirely.
    return "egress" in policy  # Egress applies only if the `egress` key itself is present.


def _k8s_port_matches(rule, protocol, port):
    """L4 finding #10b: a NetworkPolicy rule's `ports` field was never evaluated before — a policy
    allowing only port 53 read as "any port allowed". `rule["ports"]`: list of
    {"protocol": "TCP"|"UDP"|"SCTP", "port": int|str, "endPort": int (optional range end)}. An
    ABSENT/empty `ports` list means "all ports" (K8s semantics — a rule with no `ports` field
    applies to every port). When `ports` IS present but the flow's own `port` is unknown, this
    conservatively does NOT match (never fail-open on a port-restricted rule just because the
    caller didn't supply a port to check).

    Returns `True` (matched), `False` (confidently does not match), or `None` (item 2b follow-up
    fix: at least one `ports` entry names a PORT BY NAME — e.g. `"port": "http"` — that this pure
    adapter has no Service-port-name resolution for, and no OTHER entry produced a confident match;
    treating an unresolvable named port as a non-match would silently deny traffic that a real
    cluster might actually allow. `None` tells the caller this rule is unevaluable for that entry,
    not that it confidently denies)."""
    ports = rule.get("ports")
    if not ports:
        return True
    saw_unresolvable_named_port = False
    for p in ports:
        want_proto = str(p.get("protocol") or "TCP").upper()
        if protocol is not None and want_proto != str(protocol).upper():
            continue
        want_port = p.get("port")
        if want_port is None:
            return True
        if port is None:
            continue
        try:
            want_i = int(want_port)
        except (TypeError, ValueError):
            # Named port (e.g. "http") — this adapter never resolves Service/container port names,
            # so it cannot confidently say this entry does NOT match either.
            saw_unresolvable_named_port = True
            continue
        try:
            port_i = int(port)
        except (TypeError, ValueError):
            continue
        end_port = p.get("endPort")
        if end_port is not None:
            try:
                if want_i <= port_i <= int(end_port):
                    return True
            except (TypeError, ValueError):
                continue
        elif port_i == want_i:
            return True
    if saw_unresolvable_named_port:
        return None
    return False


def eval_k8s_network_policy(policies, pod_labels, direction, peer_labels=None, peer_ip=None,
                             protocol=None, port=None, data_available=True,
                             peer_namespace_labels=None, policy_namespace=None, peer_namespace=None):
    """`policies`: list of {"pod_selector": {...}, "policy_types": ["Ingress","Egress"] (optional —
    see `_policy_type_applies` for the real K8s defaulting semantics when omitted),
    "ingress"/"egress": [{"from"/"to": [...], "ports": [...]}]}.

    K8s NetworkPolicy semantics: a pod with NO policy selecting it (for this direction) is fully
    open (`allowed`). A pod selected by >=1 policy for this direction becomes default-deny for that
    direction; it is `allowed` only if at least one rule across the selecting policies matches BOTH
    the peer AND the rule's own `ports` restriction (L4 finding #10b).

    `data_available` (L4 finding #10c): the caller (network_path.py's orchestrator, which actually
    knows whether the topology fetch for this namespace/pod succeeded) must pass `False` when
    `policies` is empty because the fetch itself failed/returned no data — an empty list from a
    GENUINELY policy-free namespace (the common, correct case: most clusters have zero
    NetworkPolicies, and that legitimately means default-allow) must stay distinguishable from "we
    don't actually know." Defaults to `True` so existing "no policy found, and we know it" callers
    are unaffected.

    `policy_namespace`/`peer_namespace` (item 2c follow-up fix): Kubernetes restricts a BARE
    `podSelector` peer (no `namespaceSelector` alongside it) to the SAME namespace as the policy
    itself — it is never cluster-wide. This function has no namespace concept in its earlier input
    contract, so a caller that can supply both of these (the policy's own namespace and the actual
    peer's namespace) gets a correctly-scoped match/no-match; a caller that supplies neither (or
    only one) gets `unknown` for that specific peer entry when its labels would otherwise match —
    never a confident cross-namespace `allowed`.

    MAJOR fix (L2 finding #2): an `ipBlock` peer with an `except` list of CIDRs must NOT match a
    peer whose IP falls inside one of those excluded CIDRs, even though it also falls inside the
    rule's main `cidr` — `except` carves that sub-range back OUT of the allow. Also, a peer entry
    using `namespaceSelector` (alone or combined with `podSelector`) selects pods by NAMESPACE
    labels this function has no way to evaluate unless the caller supplies `peer_namespace_labels`
    — silently skipping such a peer would let a real match fall through to a confident `blocked`
    (a false-deny), so when at least one candidate rule/peer could only be resolved by
    `namespaceSelector` data the caller didn't provide, the verdict is downgraded to `unknown`
    rather than `blocked` (never invent a confident verdict from data we don't have).

    Follow-up fix (item 2a): a `pod_selector` peer with `peer_labels=None`, or an `ip_block` peer
    with `peer_ip=None`, used to fall straight through to a confident `blocked` (indistinguishable
    from a genuine, evaluated non-match) — both are now tracked the same way the namespaceSelector
    gap already is, and downgrade the final verdict to `unknown` when nothing else confidently
    matched.
    """
    if not data_available:
        return {"layer": "k8s-networkpolicy", "status": "unknown", "resource": None,
                "summary": "NetworkPolicy data was not fetched for this pod/namespace — cannot "
                           "evaluate (missing data, not a confirmed absence of policy)",
                "evidence": []}
    key = "ingress" if direction == "ingress" else "egress"
    # MAJOR fix (fail-open bug): the docstring's OWN documented input shape uses Kubernetes
    # canonical casing ("Ingress"/"Egress"), but this used to compare against the lowercase `key`
    # directly — with the documented shape, no policy ever selected the pod, so a default-deny pod
    # always returned `allowed`. `_policy_type_applies` normalizes case AND implements the real
    # defaulting-when-omitted rule (L4 finding #10a).
    selecting = [p for p in policies if _labels_match(p.get("pod_selector"), pod_labels)
                 and _policy_type_applies(p, direction)]
    if not selecting:
        return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                "summary": "no NetworkPolicy selects this pod for this direction (default allow)",
                "evidence": []}
    saw_unresolvable_namespace_selector = False
    saw_unresolvable_peer_data = False
    saw_unscoped_bare_pod_selector = False
    for policy in selecting:
        for rule in policy.get(key, []):
            port_match = _k8s_port_matches(rule, protocol, port)
            # MINOR fix (round 2): a CONFIDENT port non-match (`False`) must still skip this rule
            # immediately, exactly as before — the rule is irrelevant regardless of its peers, and
            # evaluating peers anyway can surface an UNRELATED ambiguity (e.g. a bare podSelector
            # peer whose namespace scoping can't be confirmed) that would incorrectly downgrade an
            # otherwise-confident `blocked` to `unknown`. Only an UNRESOLVABLE port (`None` — a named
            # port this adapter can't resolve) defers the decision to peer evaluation below, and even
            # then only actually taints the verdict if some peer would otherwise be a confident
            # match — a rule whose peers definitively don't match is still irrelevant regardless of
            # whether its port could be resolved (item 2b's original concern, now scoped correctly).
            if port_match is False:
                continue
            peers = rule.get("from" if direction == "ingress" else "to", [])
            if not peers:  # an empty peer list on a present rule means "allow all" for that rule
                if port_match is None:
                    saw_unresolvable_peer_data = True
                    continue
                return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                        "summary": "matching NetworkPolicy rule allows all peers", "evidence": [rule]}
            for peer in peers:
                has_ns_selector = "namespace_selector" in peer
                has_pod_selector = "pod_selector" in peer
                has_ip_block = "ip_block" in peer

                if has_ns_selector:
                    # MINOR fix: an EMPTY namespaceSelector (`{}` — no matchLabels/matchExpressions)
                    # is Kubernetes' own "match every namespace" semantics, a vacuous match that
                    # needs no namespace-label data at all. The old code checked
                    # `peer_namespace_labels is None` before even looking at whether the selector
                    # was trivial, turning a decidable `allowed` into an unnecessary `unknown`. Only
                    # a genuinely non-trivial (non-empty) selector requires namespace-label data.
                    ns_selector = peer["namespace_selector"]
                    if ns_selector:
                        if peer_namespace_labels is None:
                            # Can't evaluate a namespaceSelector peer without namespace label data
                            # — do NOT fall through to a confident blocked; remember it and keep
                            # scanning other peers/rules in case one of THEM confidently allows.
                            saw_unresolvable_namespace_selector = True
                            continue
                        if not _labels_match(ns_selector, peer_namespace_labels):
                            continue  # namespace doesn't match this peer's namespaceSelector

                if has_pod_selector:
                    # MINOR fix: same empty-selector vacuous-match treatment as namespaceSelector
                    # above — `podSelector: {}` matches every pod and needs no peer_labels.
                    pod_selector = peer["pod_selector"]
                    if pod_selector:
                        if peer_labels is None:
                            # item 2a: can't evaluate a podSelector peer without peer label data —
                            # unresolved, not a confident non-match.
                            saw_unresolvable_peer_data = True
                            continue
                        if not _labels_match(pod_selector, peer_labels):
                            continue  # labels genuinely don't match this peer — confident non-match

                    if not has_ns_selector:
                        # item 2c: a BARE podSelector (no namespaceSelector alongside it) is
                        # restricted by K8s to the policy's OWN namespace — labels matched, but we
                        # still need namespace confirmation before this can be a confident allow.
                        if policy_namespace is None or peer_namespace is None:
                            saw_unscoped_bare_pod_selector = True
                            continue
                        if policy_namespace != peer_namespace:
                            continue  # different namespace — bare podSelector cannot reach it

                    if port_match is None:
                        saw_unresolvable_peer_data = True
                        continue
                    return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                            "summary": "matched pod_selector peer rule", "evidence": [peer]}

                if has_ns_selector:
                    # namespaceSelector alone (no podSelector): matches every pod in that namespace.
                    if port_match is None:
                        saw_unresolvable_peer_data = True
                        continue
                    return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                            "summary": "matched namespaceSelector peer rule", "evidence": [peer]}

                if has_ip_block:
                    cidr = peer["ip_block"].get("cidr")
                    # MINOR fix: a present-but-malformed peer_ip must be treated the same as a
                    # missing one — see `_is_valid_ip`'s docstring.
                    if peer_ip is None or not _is_valid_ip(peer_ip):
                        # item 2a: can't evaluate an ipBlock peer without a valid peer_ip — unresolved.
                        saw_unresolvable_peer_data = True
                        continue
                    if not _cidr_contains(cidr, peer_ip):
                        continue
                    excepts = peer["ip_block"].get("except") or []
                    if any(_cidr_contains(ex, peer_ip) for ex in excepts):
                        continue  # excluded sub-range carves this peer back OUT of the allow
                    if port_match is None:
                        saw_unresolvable_peer_data = True
                        continue
                    return {"layer": "k8s-networkpolicy", "status": "allowed", "resource": None,
                            "summary": "matched ipBlock peer rule", "evidence": [peer]}
    if saw_unresolvable_namespace_selector:
        return {
            "layer": "k8s-networkpolicy", "status": "unknown", "resource": None,
            "summary": "a candidate NetworkPolicy rule uses namespaceSelector but the caller did "
                       "not supply peer namespace labels — cannot confidently evaluate", "evidence": [],
        }
    if saw_unscoped_bare_pod_selector:
        return {
            "layer": "k8s-networkpolicy", "status": "unknown", "resource": None,
            "summary": "a candidate NetworkPolicy rule's bare podSelector peer's labels match, but "
                       "the policy's own namespace and/or the peer's namespace were not supplied — "
                       "cannot confirm the same-namespace scoping K8s requires for a bare podSelector",
            "evidence": [],
        }
    if saw_unresolvable_peer_data:
        return {
            "layer": "k8s-networkpolicy", "status": "unknown", "resource": None,
            "summary": "a candidate NetworkPolicy rule could not be evaluated due to missing peer "
                       "data (podSelector peer with no peer_labels, ipBlock peer with no peer_ip, or "
                       "a named port this adapter cannot resolve) — cannot confidently evaluate",
            "evidence": [],
        }
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
    """Bounded stub for Cilium (policy + egress gateways) and Istio VirtualService, DestinationRule,
    Gateway, AuthorizationPolicy, PeerAuthentication. This is intentionally NOT a full live policy
    evaluator (see the report: these stay correctly-stubbed-`unknown`, detection-only) — it never
    returns `allowed`/`blocked` for a schema it cannot fully parse, satisfying the spec's
    "Unsupported versions, missing CRDs ... become `?`. They never become `O`."

    Its three branches already distinguish "genuinely no mesh CRD installed" from "CRD present, but
    an unsupported version" from "CRD present and a supported version, but not evaluated" via
    `crd_present`/`observed_api_version` — the DETECTION half of gap 2's ask is already real here;
    what remains a stub is the actual rule evaluation for Cilium/Istio (no code in this worker reads
    live Cilium/Istio CRD content today — see the report for why: this worker has no live K8s client
    at all, only whatever the topology fetcher/discover phase supplies in `data`). Calico now has its
    OWN dedicated evaluator (`eval_calico_policy`, below) wired into network_path.py in place of this
    stub — this function is kept for Cilium/Istio and for any caller that still wants the pre-Calico
    stub behavior directly (e.g. the TestMeshPolicyStub suite exercising it with kind="calico").
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


# ── Kubernetes policy: Calico NetworkPolicy (projectcalico.org/v3) — REAL evaluation ────────────

_CALICO_TERM_RE = re.compile(r"^\s*([\w./-]+)\s*(==|!=|not\s+in|in)\s*(.+?)\s*$")


def _parse_calico_value_list(raw):
    raw = raw.strip()
    if raw.startswith("{") and raw.endswith("}"):
        raw = raw[1:-1]
    return [v.strip().strip("'\"") for v in raw.split(",") if v.strip()]


def _calico_selector_matches(selector, labels):
    """Evaluate a Calico label-selector STRING against `labels` (dict).

    Returns `True`/`False` for a confidently-evaluated selector, or `None` when the selector uses a
    construct this bounded parser cannot confidently evaluate — callers MUST treat `None` as
    unresolvable (never as a confident non-match), matching every other "missing data -> never a
    fabricated verdict" rule in this module.

    Supported subset: `''`/`'all()'` (matches everything — Calico's own "select everything");
    a FLAT `&&`-joined conjunction of `key == 'value'` / `key != 'value'` / `key in {'a','b'}` /
    `key not in {'a','b'}` terms. Calico's selector language is a much larger boolean DSL
    (`||`, `has()`/`!has()`, parenthesized grouping, glob-style operators) — none of that is
    supported here; any of it makes this return `None` rather than guess.
    """
    selector = (selector or "").strip()
    if selector in ("", "all()"):
        return True
    if "||" in selector or "has(" in selector or "(" in selector.replace("all()", ""):
        return None
    for term in (t.strip() for t in selector.split("&&")):
        m = _CALICO_TERM_RE.match(term)
        if not m:
            return None
        key, op, val = m.groups()
        op = re.sub(r"\s+", " ", op.strip())
        actual = (labels or {}).get(key)
        if op == "==":
            if actual != val.strip("'\""):
                return False
        elif op == "!=":
            if actual == val.strip("'\""):
                return False
        elif op == "in":
            if actual not in _parse_calico_value_list(val):
                return False
        elif op == "not in":
            if actual in _parse_calico_value_list(val):
                return False
        else:  # pragma: no cover — regex only captures the 4 ops above
            return None
    return True


def _calico_policy_type_applies(policy, direction):
    """Calico's `types` defaulting: when present, only that explicit list applies (case-insensitive,
    same as core K8s). When OMITTED, Calico's own docs default on RULE PRESENCE for BOTH directions
    symmetrically (unlike core K8s's `_policy_type_applies`, which always defaults Ingress on
    regardless of rule presence) — Ingress applies iff an `ingress` key is present, Egress iff an
    `egress` key is present."""
    types = policy.get("types")
    if types:
        want = "ingress" if direction == "ingress" else "egress"
        return want in {str(t).lower() for t in types}
    key = "ingress" if direction == "ingress" else "egress"
    return key in policy


def eval_calico_policy(policies, pod_labels, direction, crd_present=True, observed_api_version=None,
                        peer_labels=None, peer_ip=None, peer_namespace_labels=None,
                        protocol=None, port=None, data_available=True):
    """Real Calico NetworkPolicy (`projectcalico.org/v3`) evaluation — deliberately reuses
    `eval_k8s_network_policy`'s port-matching (`_k8s_port_matches`) and CIDR/IP helpers
    (`_cidr_contains`/`_is_valid_ip`), since Calico's policy model is a superset of core K8s
    NetworkPolicy for the overlapping feature set (selector-based allow rules, default-deny-once-
    selected, per-rule ports, CIDR/`nets` peers). It differs mainly in its label-selector language
    (a string DSL, `_calico_selector_matches`) instead of core K8s's dict `matchLabels`, and in its
    peer shape (`source`/`destination` carrying `selector`/`namespaceSelector`/`nets` together,
    ANDed, rather than core K8s's `from`/`to` peer list of alternative OR'd peer entries).

    `policies`: [{"selector": str, "types": ["Ingress","Egress"] (optional),
    "ingress"/"egress": [{"action": "Allow"|"Deny"|"Log"|"Pass" (only "Allow" rules are ever
    evaluated — see below), "source"/"destination": {"selector": str, "namespaceSelector": str,
    "nets": [cidr, ...]}, "protocol": str, "ports": [...]}]}.

    Only `action: Allow` rules ever contribute a confident `allowed` — a `Deny`/`Log`/`Pass` rule
    that would otherwise match is simply skipped (not evaluated as a blocker), matching this
    feature's "never invent a confident `blocked` from a mechanism this adapter cannot fully model"
    rule: Calico's real deny/pass precedence also depends on `order` across policies (lower order
    wins, ties are undefined across tiers), which this bounded evaluator does not model — assigning
    a Deny/Pass rule an authoritative `blocked` here could be wrong relative to a differently-ordered
    Allow elsewhere. The final "no Allow rule matched" case still correctly reduces to `blocked`
    (mirrors `eval_k8s_network_policy`'s own default-deny-once-selected semantics), since the ABSENCE
    of any matching Allow is itself confidently evaluable without needing Calico's ordering model.
    """
    layer = "k8s-calico"
    if not crd_present:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": "calico CRD not installed in this cluster", "evidence": []}
    if observed_api_version not in _SUPPORTED_CRD_VERSIONS.get("calico", set()):
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": f"unsupported calico apiVersion {observed_api_version!r}", "evidence": []}
    if not data_available:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": "Calico NetworkPolicy data was not fetched for this pod/namespace — "
                           "cannot evaluate (missing data, not a confirmed absence of policy)",
                "evidence": []}

    selecting = []
    for p in policies:
        match = _calico_selector_matches(p.get("selector"), pod_labels)
        if match is None:
            return {"layer": layer, "status": "unknown", "resource": None,
                    "summary": "a Calico policy's own selector uses a construct this adapter cannot "
                               "confidently evaluate (supported subset: '', 'all()', or a flat && "
                               "chain of ==/!=/in/not-in terms)", "evidence": []}
        if match and _calico_policy_type_applies(p, direction):
            selecting.append(p)
    if not selecting:
        return {"layer": layer, "status": "allowed", "resource": None,
                "summary": "no Calico NetworkPolicy selects this pod for this direction (default allow)",
                "evidence": []}

    key = "ingress" if direction == "ingress" else "egress"
    saw_unresolvable = False
    for policy in selecting:
        for rule in policy.get(key, []):
            if str(rule.get("action", "Allow")).lower() != "allow":
                continue  # Deny/Log/Pass — not evaluated, see docstring
            port_match = _k8s_port_matches(
                {"ports": rule.get("ports")} if rule.get("ports") else {},
                protocol or rule.get("protocol"), port)
            if port_match is False:
                continue
            peer = rule.get("source" if direction == "ingress" else "destination") or {}
            selector, ns_selector, nets = peer.get("selector"), peer.get("namespaceSelector"), peer.get("nets")
            if not selector and not ns_selector and not nets:
                if port_match is None:
                    saw_unresolvable = True
                    continue
                return {"layer": layer, "status": "allowed", "resource": None,
                        "summary": "matching Calico rule allows all peers", "evidence": [rule]}
            if ns_selector:
                ns_match = _calico_selector_matches(ns_selector, peer_namespace_labels)
                if ns_match is None:
                    saw_unresolvable = True
                    continue
                if not ns_match:
                    continue
            if selector:
                if peer_labels is None:
                    saw_unresolvable = True
                    continue
                pod_match = _calico_selector_matches(selector, peer_labels)
                if pod_match is None:
                    saw_unresolvable = True
                    continue
                if not pod_match:
                    continue
            if nets:
                if peer_ip is None or not _is_valid_ip(peer_ip):
                    saw_unresolvable = True
                    continue
                if not any(_cidr_contains(n, peer_ip) for n in nets):
                    continue
            if port_match is None:
                saw_unresolvable = True
                continue
            return {"layer": layer, "status": "allowed", "resource": None,
                    "summary": "matched Calico rule peer", "evidence": [rule]}
    if saw_unresolvable:
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": "a candidate Calico rule could not be confidently evaluated due to "
                           "missing peer data or a selector construct this adapter cannot parse",
                "evidence": []}
    return {"layer": layer, "status": "blocked", "resource": None,
            "summary": "pod is selected by >=1 Calico NetworkPolicy for this direction; no Allow "
                       "rule matched the peer", "evidence": []}


# ── DNS/L7: Route 53 resolution ─────────────────────────────────────────────────────────────────

def eval_route53_resolution(records, query_host, data_available=True):
    """Real Route 53 resolution evaluation, given already-fetched hosted-zone record data (this
    module makes no AWS calls itself — see the module docstring; a caller/orchestrator that has read
    `ListResourceRecordSets` and, for ALIAS/failover records, health-check status is expected to
    supply it here).

    `records`: [{"name": str, "type": "A"|"AAAA"|"CNAME"|"ALIAS"|..., "alias_target": str|None,
    "health_check_status": "healthy"|"unhealthy"|None, "failover": "PRIMARY"|"SECONDARY"|None}].
    Matching: exact name match, else the name's own wildcard record (`*.<parent>`) one label up,
    else (for a CNAME target) one hop of chain-following. Not a full recursive resolver — this is
    read-only zone-data inspection, never an actual DNS query (spec's "no active probe" boundary).
    """
    if not data_available:
        return {"layer": "dns", "status": "unknown", "resource": None,
                "summary": "Route 53 record data was not fetched for this hosted zone — cannot "
                           "evaluate (missing data, not a confirmed absence of a record)",
                "evidence": []}
    host = (query_host or "").rstrip(".").lower()
    if not host:
        return {"layer": "dns", "status": "unknown", "resource": None,
                "summary": "no query host supplied; cannot evaluate Route 53 resolution",
                "evidence": []}
    by_name = {}
    for r in records or []:
        by_name.setdefault(str(r.get("name", "")).rstrip(".").lower(), []).append(r)

    def _find(name, depth=0):
        if depth > 5:  # bounded CNAME-chain following — never loop forever on a misconfigured zone
            return None
        if name in by_name:
            return by_name[name]
        wildcard = "*." + name.split(".", 1)[1] if "." in name else None
        if wildcard and wildcard in by_name:
            return by_name[wildcard]
        return None

    matched = _find(host)
    if matched is None:
        return {"layer": "dns", "status": "blocked", "resource": None,
                "summary": f"no Route 53 record resolves {host!r} (NXDOMAIN against known zone data)",
                "evidence": []}
    # A CNAME with no further usable data at its target is followed one hop, still within the
    # already-fetched `records` set (no live DNS query is ever issued).
    seen_names = {host}
    while len(matched) == 1 and matched[0].get("type") == "CNAME" and matched[0].get("alias_target"):
        target = str(matched[0]["alias_target"]).rstrip(".").lower()
        if target in seen_names:
            break
        seen_names.add(target)
        nxt = _find(target)
        if nxt is None:
            break
        matched = nxt

    unhealthy = [r for r in matched if r.get("health_check_status") == "unhealthy"]
    healthy_or_unchecked = [r for r in matched if r.get("health_check_status") != "unhealthy"]
    if unhealthy and not healthy_or_unchecked:
        return {"layer": "dns", "status": "blocked", "resource": host,
                "summary": f"Route 53 record(s) for {host!r} all report an unhealthy health check",
                "evidence": matched}
    if unhealthy and healthy_or_unchecked:
        return {"layer": "dns", "status": "conditional", "resource": host,
                "summary": (
                    f"Route 53 has both healthy and unhealthy record(s) for {host!r} (e.g. a "
                    "failover/weighted set) — which one actually answers a given query is not "
                    "resolved from zone data alone"),
                "evidence": matched}
    return {"layer": "dns", "status": "allowed", "resource": host,
            "summary": f"Route 53 resolves {host!r}", "evidence": matched}


# ── DNS/L7: Kubernetes Ingress -> Service -> EndpointSlice resolution ───────────────────────────

def eval_k8s_service_resolution(ingress_rules, services, endpoint_slices, request, data_available=True):
    """Real Ingress -> Service -> EndpointSlice resolution, given already-fetched K8s objects — this
    module never calls the Kubernetes API itself (no code path in this worker holds a live K8s
    client at all; see network_path.py's own docstring/report for why this layer stays unreachable
    in practice until a live K8s read path is added upstream of this pure function). Implemented for
    real now so that wiring is a data-plumbing change only, not a logic change, once such a read path
    exists.

    `ingress_rules`: [{"host": str|None, "path": str|None, "path_type": "Exact"|"Prefix"|"ImplementationSpecific",
    "backend_service": str, "backend_port": int}].
    `services`: {service_name: {"selector": {...}, "ports": [{"port": int, "target_port": int}]}}.
    `endpoint_slices`: {service_name: [{"ready": bool}, ...]} (one entry per endpoint).
    `request`: {"host": str|None, "path": str|None, "port": int|None}.
    """
    if not data_available:
        return {"layer": "k8s-service-resolution", "status": "unknown", "resource": None,
                "summary": "Ingress/Service/EndpointSlice data was not fetched — cannot evaluate",
                "evidence": []}
    req_host = request.get("host")
    req_path = request.get("path") or "/"

    def _path_ok(rule):
        rp = rule.get("path")
        if not rp:
            return True
        pt = rule.get("path_type", "ImplementationSpecific")
        if pt == "Exact":
            return req_path == rp
        if pt == "Prefix":
            return req_path == rp.rstrip("/") or req_path.startswith(rp if rp.endswith("/") else rp + "/")
        return req_path.startswith(rp)  # ImplementationSpecific: treat as a prefix, conservatively

    matched_rule = next(
        (r for r in (ingress_rules or [])
         if (r.get("host") is None or r.get("host") == req_host) and _path_ok(r)),
        None)
    if matched_rule is None:
        return {"layer": "k8s-service-resolution", "status": "blocked", "resource": None,
                "summary": f"no Ingress rule matches host={req_host!r} path={req_path!r}",
                "evidence": []}
    svc_name = matched_rule.get("backend_service")
    svc = (services or {}).get(svc_name)
    if svc is None:
        return {"layer": "k8s-service-resolution", "status": "blocked", "resource": svc_name,
                "summary": f"Ingress backend Service {svc_name!r} does not exist", "evidence": []}
    eps = (endpoint_slices or {}).get(svc_name, [])
    ready = [e for e in eps if e.get("ready")]
    if not eps:
        return {"layer": "k8s-service-resolution", "status": "blocked", "resource": svc_name,
                "summary": f"Service {svc_name!r} has no EndpointSlice entries (no pods matched its selector)",
                "evidence": []}
    if not ready:
        return {"layer": "k8s-service-resolution", "status": "blocked", "resource": svc_name,
                "summary": f"Service {svc_name!r} has {len(eps)} endpoint(s), none ready", "evidence": []}
    if len(ready) < len(eps):
        return {"layer": "k8s-service-resolution", "status": "conditional", "resource": svc_name,
                "summary": f"Service {svc_name!r}: {len(ready)}/{len(eps)} endpoints ready",
                "evidence": eps}
    return {"layer": "k8s-service-resolution", "status": "allowed", "resource": svc_name,
            "summary": f"Ingress resolves to Service {svc_name!r} with {len(ready)} ready endpoint(s)",
            "evidence": eps}
