"""
Inventory-Read MCP Lambda — Aurora-backed, read-only topology & unused-resource tool.

The v2 equivalent of v1's ops `run_steampipe_query`: instead of querying live Steampipe, it reads
the inventory the Steampipe sync already materialized into Aurora (`inventory_resources` +
`topology_nodes/edges`, ADR-043) and answers topology / unused-resource questions over it. This
reconnects "the topology data we built in Aurora" to AgentCore — the bridge that was missing in v2.

Tools (all read-only — SELECT only; no AWS mutation, no arbitrary SQL):
  - find_unused_resources : orphan TGs, empty CloudFront origins, dead/idle LBs, unattached EBS …
  - query_inventory       : list/filter synced resources by type
  - get_topology          : CF→LB→TG→target chain from the materialized graph
  - inventory_summary     : counts by type + sync freshness

VPC Lambda → pg8000 (NOT psycopg2), per agent/lambda/CLAUDE.md. DB access is lazy + injectable so
the pure detection logic (detect_unused) is unit-testable with fixtures (no DB, no boto3).

인벤토리-읽기 MCP 람다 — v2의 ops `run_steampipe_query` 등가물. Aurora에 동기화된 토폴로지/인벤토리를
읽어 미사용 리소스·토폴로지 질의에 답한다. 전부 읽기 전용(SELECT만).
"""
import json
import os
import ssl


# ── Resource types the topology/unused detection reads (mirrors graph-store TYPE_TO_KEY) ──────────
TOPOLOGY_TYPES = ["cloudfront", "alb", "nlb", "target_group", "ec2", "ebs", "security_group",
                  "route53", "lambda", "ecs_task", "s3"]

# Coverage note: EIP / ENI / ELB listeners are NOT in the inventory sync yet, so listener-less LBs
# and unattached EIP/ENI are out of scope for the Aurora-backed detector (live-API only).
COVERAGE_NOTE = ("Derived from the synced Aurora inventory (inventory_resources). Elastic IPs, "
                 "detached ENIs, and ELB listeners are not synced yet, so those are out of scope "
                 "here. Freshness = the latest inventory sync; see inventory_summary().")


# ── Pure detection logic (fixture-testable; no DB) ───────────────────────────────────────────────
def _states(tg):
    """Health states of a target_group's registered targets (PascalCase AWS SDK shape)."""
    return [(d.get("TargetHealth") or {}).get("State") for d in (tg.get("target_health_descriptions") or [])]


def detect_unused(by_type):
    """Detect unused/orphaned resources from synced inventory rows.

    `by_type` maps resource_type -> list of the JSONB `data` dicts of inventory_resources.
    Returns a flat list of findings: {category, resource_type, resource_id, name, reason, severity}.
    """
    findings = []
    tgs = by_type.get("target_group") or []
    albs = by_type.get("alb") or []
    nlbs = by_type.get("nlb") or []

    # LB lookup helpers for the CloudFront origin join.
    lb_by_dns = {}
    for lb in albs + nlbs:
        dns = lb.get("dns_name")
        if dns:
            lb_by_dns[dns] = lb
    # Total healthy targets behind each LB ARN (across all its target groups).
    healthy_by_lb_arn = {}
    for tg in tgs:
        healthy = sum(1 for s in _states(tg) if s == "healthy")
        for arn in (tg.get("load_balancer_arns") or []):
            healthy_by_lb_arn[arn] = healthy_by_lb_arn.get(arn, 0) + healthy

    # ── Target groups ──
    for tg in tgs:
        name = tg.get("target_group_name") or tg.get("target_group_arn") or "?"
        rid = tg.get("target_group_arn") or name
        lb_arns = tg.get("load_balancer_arns") or []
        states = _states(tg)
        registered = len(states)
        healthy = sum(1 for s in states if s == "healthy")
        if not lb_arns:
            reason = "Orphan target group: not attached to any load balancer"
            reason += " and 0 registered targets." if registered == 0 else f"; {registered} target(s) registered but no listener routes to it."
            findings.append({"category": "TargetGroup (orphan, no LB)", "resource_type": "TargetGroup",
                             "resource_id": rid, "name": name, "reason": reason, "severity": "high"})
        elif healthy == 0:
            findings.append({"category": "TargetGroup (attached, 0 healthy)", "resource_type": "TargetGroup",
                             "resource_id": rid, "name": name, "severity": "high",
                             "reason": f"Attached to a load balancer but 0 healthy targets ({registered} registered, all unhealthy/unused) — the listener path is dead."})

    # ── CloudFront distributions ──
    for cf in by_type.get("cloudfront") or []:
        cid = cf.get("id") or cf.get("arn") or "?"
        aliases = cf.get("aliases")
        label = cid
        if isinstance(aliases, dict) and aliases.get("Items"):
            label = aliases["Items"][0]
        if not cf.get("enabled", True):
            findings.append({"category": "CloudFront (disabled)", "resource_type": "CloudFront",
                             "resource_id": cid, "name": label, "severity": "medium",
                             "reason": "Distribution is disabled (Enabled=false) — likely abandoned."})
            continue
        for origin in (cf.get("origins") or []):
            domain = origin.get("DomainName") if isinstance(origin, dict) else None
            if domain and domain in lb_by_dns:
                lb = lb_by_dns[domain]
                if healthy_by_lb_arn.get(lb.get("arn"), 0) == 0:
                    findings.append({"category": "CloudFront (empty origin)", "resource_type": "CloudFront",
                                     "resource_id": cid, "name": label, "severity": "high",
                                     "reason": f"Origin points at {lb.get('name')} which has no healthy backend targets — the origin serves nothing (empty/dead chain)."})
                    break

    # ── EBS volumes ──
    for vol in by_type.get("ebs") or []:
        if vol.get("state") == "available":
            vid = vol.get("volume_id") or "?"
            size = vol.get("size")
            findings.append({"category": "EBS volume (unattached)", "resource_type": "EBS",
                             "resource_id": vid, "name": vid, "severity": "high",
                             "reason": f"Volume is 'available' (unattached){f' — {size} GiB' if size else ''} — pure storage cost."})

    return findings


def build_topology_chain(by_type, root=None):
    """Trace CF→LB→TG→target chains from synced inventory (for get_topology)."""
    albs = {lb.get("dns_name"): lb for lb in (by_type.get("alb") or []) + (by_type.get("nlb") or [])}
    tgs_by_lb = {}
    for tg in by_type.get("target_group") or []:
        for arn in (tg.get("load_balancer_arns") or []):
            tgs_by_lb.setdefault(arn, []).append(tg)
    chains = []
    for cf in by_type.get("cloudfront") or []:
        if root and root not in (cf.get("id"), cf.get("domain_name")):
            continue
        for origin in (cf.get("origins") or []):
            domain = origin.get("DomainName") if isinstance(origin, dict) else None
            lb = albs.get(domain)
            node = {"cloudfront": cf.get("id"), "origin": domain, "loadBalancer": lb.get("name") if lb else None,
                    "targetGroups": [{"name": t.get("target_group_name"),
                                      "healthy": sum(1 for s in _states(t) if s == "healthy"),
                                      "registered": len(_states(t))}
                                     for t in (tgs_by_lb.get(lb.get("arn"), []) if lb else [])]}
            chains.append(node)
    return chains


# ── Aurora access (lazy; VPC Lambda uses pg8000 + RDS-managed master secret) ──────────────────────
_secret_cache = {}
_get_secret_override = None  # tests may inject


def _get_secret():
    if _get_secret_override:
        return _get_secret_override()
    import boto3  # lazy: keep pure logic importable without boto3
    arn = os.environ["AURORA_SECRET_ARN"]
    if arn not in _secret_cache:
        sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
        _secret_cache[arn] = json.loads(sm.get_secret_value(SecretId=arn)["SecretString"])
    return _secret_cache[arn]


def _connect():
    import pg8000.native  # lazy
    sec = _get_secret()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return pg8000.native.Connection(
        user=sec["username"], password=sec["password"],
        host=os.environ["AURORA_ENDPOINT"], database=os.environ.get("AURORA_DATABASE", "awsops"),
        ssl_context=ctx,
    )


def _fetch_by_type(types, limit_per_type=2000):
    """Read inventory_resources.data grouped by resource_type. Returns {type: [data, ...]}."""
    conn = _connect()
    try:
        out = {}
        rows = conn.run(
            "SELECT resource_type, data FROM inventory_resources "
            "WHERE resource_type = ANY(:types) AND account_id = 'self'",
            types=list(types),
        )
        for rtype, data in rows:
            d = data if isinstance(data, dict) else json.loads(data)
            out.setdefault(rtype, []).append(d)
        return out
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _sync_freshness():
    conn = _connect()
    try:
        rows = conn.run("SELECT resource_type, status, finished_at, row_count FROM inventory_sync_runs "
                        "WHERE account_id = 'self' ORDER BY resource_type")
        return [{"resource_type": r[0], "status": r[1], "finished_at": str(r[2]), "row_count": r[3]} for r in rows]
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ── Tool dispatch ─────────────────────────────────────────────────────────────────────────────────
def _ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}


def lambda_handler(event, context):
    """Entry point. Read-only: every tool issues SELECT-only queries against Aurora."""
    params = event if isinstance(event, dict) else json.loads(event)
    tool_name = params.get("tool_name", "") or ""
    arguments = params.get("arguments", params)
    if isinstance(arguments, dict):
        arguments.pop("target_account_id", None)  # single-account; accept-and-ignore

    if tool_name in ("find_unused_resources", ""):
        by_type = _fetch_by_type(["target_group", "alb", "nlb", "cloudfront", "ebs"])
        findings = detect_unused(by_type)
        category = arguments.get("category") if isinstance(arguments, dict) else None
        if category:
            findings = [f for f in findings if category.lower() in f["category"].lower()]
        return _ok({"findings": findings, "count": len(findings), "note": COVERAGE_NOTE})

    if tool_name == "get_topology":
        root = arguments.get("resource_id") if isinstance(arguments, dict) else None
        by_type = _fetch_by_type(["cloudfront", "alb", "nlb", "target_group"])
        return _ok({"chains": build_topology_chain(by_type, root), "note": COVERAGE_NOTE})

    if tool_name == "query_inventory":
        rtype = arguments.get("resource_type") if isinstance(arguments, dict) else None
        if not rtype:
            return {"statusCode": 400, "body": json.dumps({"error": "resource_type required"})}
        limit = int(arguments.get("limit", 200)) if isinstance(arguments, dict) else 200
        rows = _fetch_by_type([rtype]).get(rtype, [])[:limit]
        return _ok({"resource_type": rtype, "count": len(rows), "resources": rows})

    if tool_name == "inventory_summary":
        return _ok({"sync": _sync_freshness(), "note": COVERAGE_NOTE})

    return {"statusCode": 400, "body": json.dumps({"error": "Unknown tool: " + str(tool_name)})}
