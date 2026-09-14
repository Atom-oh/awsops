"""Bounded logical-call receipts from public Strands messages; never save raw results.

Clocks observe stream delivery, including batched results, not execution duration.
These receipts do not audit internal SDK retries.
"""
import json
import math
import re
import time
from datetime import datetime
from ipaddress import ip_address

MAX_CALLS = 32
MAX_RESULT = 262144
ASYNC_QUERY_TOOLS = {
    "execute_log_insights_query", "get_logs_insight_query_results",
    "lake_query", "get_query_status", "get_query_results",
}
ISTIO_COUNTS = ("virtualservices", "destinationrules", "gateways", "serviceentries",
                "authorizationpolicies", "peerauthentications")
IAM_LISTS = {"list_users": "users", "list_roles": "roles", "list_groups": "groups", "list_policies": "policies"}
COUNTED_LISTS = {
    "search_opensearch_logs": ("hits", "total"), "get_dimension_values": ("values", "count"),
    "list_tables": ("tables", "count"), "query_table": ("items", "count"), "scan_table": ("items", "count"),
}
PAGINATED_TOOLS = set(IAM_LISTS) | {"list_tables", "query_table", "scan_table", "get_dimension_values"}
SHALLOW_TOOLS = set(COUNTED_LISTS) | set(IAM_LISTS) | {
    "get_trusted_advisor_cost_checks", "list_opensearch_domains", "opensearch_schema",
    "mesh_overview", "check_cloudformation_template_compliance", "describe_network", "get_item",
}
METRIC_QUERIES = {"prometheus_query", "prometheus_query_range", "mimir_query", "mimir_query_range"}
LOKI_QUERIES = {"loki_query", "loki_query_range"}
NAMED_LISTS = {
    "prometheus_labels": ("labels", 1000, str), "mimir_labels": ("labels", 1000, str),
    "prometheus_series": ("series", 50, dict), "mimir_series": ("series", 50, dict),
    "loki_labels": ("labels", 1000, str), "loki_label_values": ("values", 1000, str),
}
POSITIVE_TOOLS = METRIC_QUERIES | LOKI_QUERIES | set(NAMED_LISTS) | {
    "get_eni_details", "find_ip_address", "get_topology", "notion_search",
    "notion_query_database", "notion_fetch_page", "tempo_search", "tempo_get_trace",
}
STATUS = {"ok", "empty", "partial", "unavailable", "error", "unknown"}
REASONS = {
    "missing_ledger", "unknown_account_coverage", "source_failed", "incomplete_collection",
    "unknown_attributes", "empty_not_confirmed", "unknown_capture", "publication_failed",
    "read_failed", "response_missing", "truncated", "scope_missing", "ambiguous", "missing",
    "identity_missing", "target_missing", "destination_missing", "snapshot_changed",
}
INPUT_PATTERNS = {
    "target_account_id": r"\d{12}", "account_id": r"\d{12}",
    "region": r"[a-z]{2}(?:-[a-z]+){1,2}-\d",
    "resource_id": r"(?:eni|sg|vpc|subnet|i|rtb|acl|nat|tgw)-[a-zA-Z0-9-]{1,64}",
    "eni_id": r"eni-[a-zA-Z0-9-]{1,64}", "vpc_id": r"vpc-[a-zA-Z0-9-]{1,64}",
}


def matching(value, pattern, limit=128):
    return isinstance(value, str) and len(value) <= limit and re.fullmatch(pattern, value) is not None


def safe_inputs(value):
    if not isinstance(value, dict):
        return {}
    return {k: value[k] for k, pattern in INPUT_PATTERNS.items() if matching(value.get(k), pattern)}


def scope(value):
    value = value if isinstance(value, dict) else {}
    fields = {"accountId": r"\d{12}", "region": INPUT_PATTERNS["region"],
              "resourceId": INPUT_PATTERNS["resource_id"]}
    return {k: value[k] for k, pattern in fields.items() if matching(value.get(k), pattern)}


def number(value):
    return type(value) in (int, float) and 0 <= value <= 9007199254740991 and math.isfinite(value)


def quality(body):
    """Explicit quality only. Invalid present fields taint; absent fields stay absent."""
    out = {}

    def fields(src, dest, rules, other_keys=None):
        if other_keys is not None and src.keys() - rules.keys() - set(other_keys):
            out["unsupported"] = True
        for key, valid in rules.items():
            if key in src:
                if valid(src[key]):
                    dest[key] = src[key]
                else:
                    out["invalid"] = True

    def one_of(values):
        return lambda v: isinstance(v, str) and v in values

    boolean = lambda v: type(v) is bool
    clock = lambda v: v is None or matching(v, r"\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?", 40)
    fields(body, out, {"partial": boolean, "truncated": boolean})
    if "unknown" in body:
        if type(body["unknown"]) is bool or isinstance(body["unknown"], list):
            out["unknown"] = bool(body["unknown"])
        else:
            out["invalid"] = True
    for key in ("selection", "routeSelection", "truncation", "collection"):
        if key not in body:
            continue
        value = body[key]
        if not isinstance(value, dict):
            out["invalid"] = True
            continue
        if key == "selection":
            if one_of({"all", "resolved", "not_found", "ambiguous"})(value.get("status")):
                out[key] = value["status"]
            else:
                out["invalid"] = True
        elif key == "routeSelection":
            out[key] = {"status": "selected" if value.get("status") == "selected" else "unknown"}
            if not one_of({"selected", "unknown"})(value.get("status")):
                out["invalid"] = True
            fields(value, out[key], {"basis": lambda v: v is None or one_of({"explicit", "main"})(v),
                                     "reason": one_of(REASONS)})
        elif key == "truncation":
            out[key] = {}
            if value.keys() - {"nodes", "edges", "node_limit", "edge_limit"}:
                out["unsupported"] = True
            fields(value, out[key], {"nodes": boolean, "edges": boolean,
                                     "node_limit": number, "edge_limit": number})
        else:
            c = {"status": value["status"] if one_of(STATUS)(value.get("status")) else "unknown"}
            if c["status"] == "unknown":
                out["invalid"] = True
            fields(value, c, {"stale": boolean, "retainedPrevious": boolean, "snapshotConsistent": boolean,
                              "captured_at": clock, "attempted_at": clock,
                              "evidenceKind": one_of({"inventory", "trace"}),
                              **{k: boolean for k in ("infraUnavailable", "inputTruncated", "graphTruncated")},
                              **{k: number for k in ("windowStartMs", "windowEndMs", "nodeDrops", "edgeDrops",
                                                      "orphanSpans", "invalidSpans", "unresolvedMessaging")}},
                   ("status", "sources", "publishedSources"))
            for name in ("sources", "publishedSources"):
                if name not in value:
                    continue
                raw = value[name]
                c[name] = []
                if not isinstance(raw, list):
                    out["invalid"] = True
                    continue
                if len(raw) > 8:
                    out["truncated"] = True
                for source in raw[:8]:
                    if not isinstance(source, dict):
                        out["invalid"] = True
                        continue
                    record = {"status": source["status"] if one_of(STATUS)(source.get("status")) else "unknown"}
                    if record["status"] == "unknown":
                        out["invalid"] = True
                    fields(source, record, {
                        "sourceId": lambda v: matching(v, r"(?:inventory:[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*(?::(?:\d+|default))?)", 80),
                        "scope": one_of({"account", "aggregate"}),
                        "producerStatus": one_of({"succeeded", "failed", "partial", "running", "unknown"}),
                        **{k: lambda v: v is None or number(v) for k in
                           ("capturedAtMs", "lastSuccessAtMs", "attemptedAtMs", "finishedAtMs", "itemCount",
                            "windowStartMs", "windowEndMs")},
                    }, ("status", "reasons"))
                    if "reasons" in source:
                        raw_reasons = source["reasons"]
                        if not isinstance(raw_reasons, list):
                            out["invalid"] = True
                        else:
                            record["reasons"] = [r for r in raw_reasons[:6] if one_of(REASONS)(r)]
                            if len(record["reasons"]) != len(raw_reasons):
                                out["truncated"] = True
                    c[name].append(record)
            out[key] = c
    return out


def incomplete(q):
    coll = q.get("collection", {})
    return (q.get("partial") or q.get("unknown") or q.get("truncated") or q.get("invalid") or q.get("unsupported")
            or q.get("selection") in ("not_found", "ambiguous")
            or q.get("routeSelection", {}).get("status") == "unknown"
            or any(q.get("truncation", {}).get(k) is True for k in ("nodes", "edges"))
            or coll.get("stale") or coll.get("retainedPrevious") or coll.get("snapshotConsistent") is False
            or any(coll.get(k) is True for k in ("infraUnavailable", "inputTruncated", "graphTruncated"))
            or any(coll.get(k, 0) > 0 for k in ("nodeDrops", "edgeDrops", "orphanSpans", "invalidSpans", "unresolvedMessaging"))
            or (bool(coll) and coll.get("status") not in ("ok", "empty"))
            or any(s["status"] not in ("ok", "empty")
                   for key in ("sources", "publishedSources") for s in coll.get(key, [])))


def decode(value):
    if isinstance(value, str):
        if len(value) > MAX_RESULT:
            raise ValueError("oversized")
        return json.loads(value)
    return value


def combined(outcomes):
    """A confirmed empty source is useful evidence, including beside a failed source."""
    states = set(outcomes)
    if "partial" in states:
        return "partial"
    if states & {"success", "empty"}:
        if states & {"error", "unverified"}:
            return "partial"
        return "success" if "success" in states else "empty"
    if "error" in states:
        return "error" if states == {"error"} else "partial"
    return "unverified"


def count(value):
    return type(value) is int and number(value)


def inventory_source(row, q):
    """One SQL freshness row, never a recursive walk over inventory resource data."""
    if not isinstance(row, dict):
        q["invalid"] = True
        return {"status": "unknown"}, "unverified"
    source = {}
    rtype = row.get("resource_type")
    if matching(rtype, r"[a-z][a-z0-9_]{0,60}"):
        source["sourceId"] = "inventory:" + rtype
    elif "resource_type" in row:
        q["invalid"] = True
    fresh = row.get("freshness")
    valid = isinstance(fresh, str) and fresh in {"healthy", "degraded", "stale", "unavailable"}
    current = row.get("current_count")
    if not valid or not count(current):
        q["invalid" if "freshness" in row and "current_count" in row else "unknown"] = True
        valid = False
    else:
        source["itemCount"] = current
    if "status" in row:
        status = row["status"]
        if status is None:
            source["producerStatus"] = "unknown"
        elif isinstance(status, str) and status in {"succeeded", "failed", "partial", "running"}:
            source["producerStatus"] = status
        else:
            q["invalid"] = True
            valid = False
        if fresh == "healthy" and status != "succeeded":
            q["invalid"] = True
            valid = False
    for key in ("row_count", "last_success_row_count", "unknown_attribute_count", "age_minutes", "stale_after_minutes"):
        if key in row and row[key] is not None and not count(row[key]):
            q["invalid"] = True
            valid = False
    if fresh == "healthy" and "unknown_attribute_count" in row and row["unknown_attribute_count"] != 0:
        q["invalid"] = True
        valid = False
    # These are producer clocks, not receipt delivery clocks. SQL's latest_success_at
    # already takes the oldest retained capture into account.
    for key, dest in (("latest_success_at", "capturedAtMs"), ("last_success_at", "lastSuccessAtMs"),
                      ("finished_at", "finishedAtMs")):
        if key not in row:
            continue
        value = row[key]
        if value is None:
            source[dest] = None
            if fresh == "healthy" and key != "finished_at":
                q["invalid"] = True
                valid = False
            continue
        try:
            if not matching(value, r"\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?", 40):
                raise ValueError("invalid clock")
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("clock without timezone")
            stamp = int(parsed.timestamp() * 1000)
            if not number(stamp):
                raise ValueError("invalid clock")
            source[dest] = stamp
        except (ValueError, OverflowError):
            q["invalid"] = True
            valid = False
    if not valid:
        source["status"] = "unknown"
        return source, "unverified"
    if fresh == "healthy":
        source["status"] = "empty" if current == 0 else "ok"
        return source, "empty" if current == 0 else "success"
    if fresh == "stale":
        q["collection"]["stale"] = True
    if fresh in ("stale", "degraded") or current:
        source["status"] = "partial"
        return source, "partial"
    source["status"] = "error" if row.get("status") == "failed" else "unavailable"
    return source, "error" if source["status"] == "error" else "unverified"


def inventory_evidence(body, tool, q):
    if "collection" in q:
        # This producer does not emit collection; do not erase an unexpected quality claim.
        q["unsupported"] = True
        return "unverified"
    coll = q["collection"] = {"status": "unknown", "evidenceKind": "inventory", "sources": []}
    rows = body.get("sync") if tool == "inventory_summary" else [body.get("freshness")]
    if not isinstance(rows, list):
        q["invalid"] = True
        return "unverified"
    if not rows:
        coll["status"] = "unavailable"
        return "unverified"  # no sync ledger is not a successful empty inventory
    outcomes = []
    if len(rows) > 8:
        q["truncated"] = True
        outcomes.append("unverified")
    for row in rows[:8]:
        source, outcome = inventory_source(row, q)
        coll["sources"].append(source)
        outcomes.append(outcome)
    outcome = combined(outcomes)
    coll["status"] = {"success": "ok", "unverified": "unavailable"}.get(outcome, outcome)
    if tool == "query_inventory":
        resources = body.get("resources")
        if not isinstance(resources, list) or not count(body.get("count")) or body["count"] != len(resources):
            q["invalid"] = True
            return "unverified"
        current = coll["sources"][0].get("itemCount")
        if current is not None and len(resources) > current:
            q["invalid"] = True
        filtered_identity = (body.get("resource_type") == "cloudfront"
                             and body.get("projection") == "identity_only"
                             and matching(body.get("resource_id"), r"[A-Z0-9]{5,32}", 32))
        if current is not None and len(resources) < current and not filtered_identity:
            # This producer otherwise only applies LIMIT. Its full type count cannot certify
            # a shortened page (including LIMIT 0) as complete or as a successful empty query.
            q["truncated"] = True
        if outcome in ("success", "empty"):
            # A filtered, current query may match zero even when the type has other rows.
            return "partial" if q.get("truncated") else "success" if resources else "empty"
        if resources:
            return "partial"
    return outcome


def rightsizing_evidence(body, q):
    """Exactly four advertised services; inspect markers, not recommendation/error contents."""
    services = ("ec2", "rds", "ecs", "lambda")
    selected = body.get("resourceType")
    results = body.get("results")
    if not isinstance(selected, str) or selected not in (*services, "all") or not isinstance(results, dict):
        q["invalid"] = True
        return "unverified"
    expected = services if selected == "all" else (selected,)
    # Membership is bounded even if a native JSON block contains a huge foreign mapping.
    if len(results) != sum(service in results for service in expected):
        q["unsupported"] = True
    total = body.get("totalEstimatedMonthlySavings")
    if total is None:
        q["unknown"] = True
    elif not number(total):
        q["invalid"] = True
    outcomes = []
    for service in expected:
        if service not in results:
            q["unknown"] = True
            outcomes.append("unverified")
            continue
        entry = results[service]
        if not isinstance(entry, dict):
            q["invalid"] = True
            outcomes.append("unverified")
            continue
        failed = False
        malformed = False
        if "error" in entry:
            if isinstance(entry["error"], str) and entry["error"]:
                failed = True
            else:
                malformed = True
        if "errors" in entry:
            if isinstance(entry["errors"], list):
                failed |= bool(entry["errors"])
            else:
                malformed = True
        if "truncated" in entry:
            if type(entry["truncated"]) is bool:
                if entry["truncated"]:
                    q["truncated"] = True
            else:
                malformed = True
        recs = entry.get("recommendations")
        if failed and "recommendations" not in entry and "count" not in entry:
            outcome = "error"
        elif not isinstance(recs, list) or not count(entry.get("count")) or entry["count"] != len(recs):
            malformed = True
            outcome = "unverified"
        elif failed:
            outcome = "partial" if recs else "error"
        else:
            outcome = "success" if recs else "empty"
        if malformed:
            q["invalid"] = True
            outcome = "unverified"
        elif entry.get("truncated") is True:
            outcome = "partial"
        outcomes.append(outcome)
    outcome = combined(outcomes)
    if outcome == "empty" and number(total) and total != 0:
        q["invalid"] = True
    if "error" in outcomes or "partial" in outcomes:
        q["partial"] = True
    return outcome


def query_evidence(body, tool, q):
    """These APIs return HTTP 200 while an asynchronous query is pending or failed."""
    state = body.get("status")
    if not isinstance(state, str):
        q["invalid"] = True
        return "unverified"
    if tool in ("execute_log_insights_query", "lake_query"):
        q["unknown"] = True  # submitted is not completed query evidence
        return "unverified"
    cloudwatch = tool == "get_logs_insight_query_results"
    failed = ("Failed", "Cancelled", "Timeout") if cloudwatch else ("FAILED", "CANCELLED", "TIMED_OUT")
    if state in failed:
        return "error"
    if state != ("Complete" if cloudwatch else "FINISHED"):
        q["unknown"] = True
        return "unverified"
    token = body.get("nextToken")
    if token is not None and token != "":
        if isinstance(token, str):
            q["truncated"] = True
        else:
            q["invalid"] = True
    if tool == "get_query_status":
        return "success"  # the requested status check completed; no result rows are claimed
    rows = body.get("results")
    if not isinstance(rows, list) or not count(body.get("count")) or body["count"] != len(rows):
        q["invalid"] = True
        return "unverified"
    if len(rows) >= 50 and "truncated" not in body:
        # Existing Lambda producers slice at 50 without exposing the unsliced length.
        q["unknown"] = True
    return "success" if rows else "empty"


def reported_error(value, q):
    """Only called on explicitly known producer objects; never search resource contents."""
    if "error" not in value:
        return False
    if isinstance(value["error"], str) and value["error"]:
        return True
    q["invalid"] = True
    return None


def trusted_advisor_evidence(body, q):
    checks = body.get("checks")
    if not isinstance(checks, list):
        q["invalid"] = True
        return "unverified"
    if "totalChecks" in body and (not count(body["totalChecks"]) or body["totalChecks"] != len(checks)):
        q["invalid"] = True
    outcomes = []
    for check in checks[:15]:
        if not isinstance(check, dict):
            q["invalid"] = True
            outcomes.append("unverified")
            continue
        failed = reported_error(check, q)
        if failed:
            q["unknown"] = True  # the zero savings aggregate did not assess this check
            outcomes.append("error")
        elif failed is None or not isinstance(check.get("status"), str) or not check["status"]:
            q["invalid"] = True
            outcomes.append("unverified")
        elif check["status"] not in ("ok", "warning", "error"):
            q["unknown"] = True  # includes Support's explicit not_available assessment state
            outcomes.append("unverified")
        else:
            if "flaggedCount" in check or "flaggedResources" in check:
                total, resources = check.get("flaggedCount"), check.get("flaggedResources")
                if not count(total) or not isinstance(resources, list) or total < len(resources):
                    q["invalid"] = True
                elif total > len(resources) or len(resources) > 10:
                    q["truncated"] = True
            outcomes.append("success")  # warning/error health findings are valid retrieved evidence
    if len(checks) > 15 or q.get("truncated"):
        q["truncated"] = True
        return "partial"
    if len(checks) == 15 and "truncated" not in body:
        q["unknown"] = True  # legacy producers silently sliced the full check list at 15
        return "partial"
    return combined(outcomes) if checks else "empty"


def opensearch_evidence(body, tool, q):
    domains = body.get("domains")
    if not isinstance(domains, list):
        q["invalid"] = True
        return "unverified"
    status = body.get("collectionStatus")
    if "collectionStatus" not in body:
        q["unknown"] = True
    elif status not in ("ok", "empty") or (status == "empty") != (not domains):
        q["invalid"] = True
    outcomes = []
    for domain in domains[:20]:
        if not isinstance(domain, dict):
            q["invalid"] = True
            outcomes.append("unverified")
            continue
        failed = reported_error(domain, q)
        status = domain.get("collectionStatus")
        if "collectionStatus" not in domain:
            q["unknown"] = True  # legacy empty indices may conceal an HTTP failure
        elif status not in ("ok", "empty", "error"):
            q["invalid"] = True
            outcomes.append("unverified")
            continue
        if "truncated" in domain:
            if type(domain["truncated"]) is not bool:
                q["invalid"] = True
            elif domain["truncated"]:
                q["truncated"] = True
        if failed or status == "error":
            outcomes.append("error")
        elif failed is None:
            outcomes.append("unverified")
        elif tool == "opensearch_schema":
            indices = domain.get("indices")
            if not isinstance(indices, list):
                q["invalid"] = True
                outcomes.append("unverified")
            elif status is not None and (status == "empty") != (not indices):
                q["invalid"] = True
                outcomes.append("unverified")
            else:
                outcomes.append("success" if indices else "empty")
        elif status == "empty":
            q["invalid"] = True
            outcomes.append("unverified")
        else:
            outcomes.append("success")
    if len(domains) > 20:
        q["truncated"] = True
    if q.get("truncated"):
        return "partial"  # omitted children could succeed; never certify all-failed from a prefix
    return combined(outcomes) if domains else "empty"


def mesh_evidence(body, q):
    counts = body.get("counts")
    namespaces = body.get("injected_namespaces")
    if not isinstance(counts, dict) or not isinstance(namespaces, list):
        q["invalid"] = True
        return "unverified"
    if len(counts) != sum(key in counts for key in ISTIO_COUNTS):
        q["unsupported"] = True
    outcomes = []
    for key in ISTIO_COUNTS:
        value = counts.get(key)
        if key not in counts:
            q["unknown"] = True
            outcomes.append("unverified")
        elif value is None:
            q["unknown"] = True
            outcomes.append("error")
        elif not count(value):
            q["invalid"] = True
            outcomes.append("unverified")
        else:
            outcomes.append("success" if value else "empty")
    status = body.get("namespaceCollectionStatus")
    if "namespaceCollectionStatus" not in body:
        q["unknown"] = True
        outcomes.append("success" if namespaces else "unverified")
    elif status == "error":
        outcomes.append("partial" if namespaces else "error")
    elif status not in ("ok", "empty") or (status == "empty") != (not namespaces):
        q["invalid"] = True
        outcomes.append("unverified")
    else:
        outcomes.append("success" if namespaces else "empty")
    return combined(outcomes)


def shallow_evidence(body, tool, q):
    if tool == "get_trusted_advisor_cost_checks":
        return trusted_advisor_evidence(body, q)
    if tool in ("list_opensearch_domains", "opensearch_schema"):
        return opensearch_evidence(body, tool, q)
    if tool == "mesh_overview":
        return mesh_evidence(body, q)
    if tool == "check_cloudformation_template_compliance":
        validation = body.get("validation")
        if not isinstance(validation, dict) or type(validation.get("valid")) is not bool or not isinstance(body.get("compliance_issues"), list):
            q["invalid"] = True
            return "unverified"
        failed = reported_error(validation, q)
        if failed:
            q["unknown"] = True
            return "partial"  # local heuristic findings survive the failed remote validation
        if failed is None or not validation["valid"]:
            q["unknown"] = True
            return "unverified"
        return "success"
    if tool == "get_item":
        found, item = body.get("found"), body.get("item")
        if type(found) is not bool or "item" not in body or (found and not isinstance(item, dict)) or (not found and item is not None):
            q["invalid"] = True
            return "unverified"
        return "success" if found else "empty"
    if tool == "search_opensearch_logs":
        verdict = source_collection(body, q)
        if verdict is not None:
            return verdict
        if type(body.get("timedOut")) is not bool or not count(body.get("failedShards")):
            q["unknown"] = True
            return "unverified"
        if body["timedOut"] or body["failedShards"] > 0:
            q["partial"] = True
            return "partial"
    if tool in PAGINATED_TOOLS and "truncated" not in body:
        q["unknown"] = True  # old producers dropped continuation markers
    if tool == "describe_network":
        keys = [k for k in ("SecurityGroups", "NetworkAcls", "RouteTables", "Subnets", "Vpcs") if k in body]
        if len(keys) != 1:
            q["invalid"] = True
            return "unverified"
        field = keys[0]
        token = body.get("NextToken")
        if token is not None and token != "":
            if isinstance(token, str):
                q["truncated"] = True
            else:
                q["invalid"] = True
    else:
        field = COUNTED_LISTS[tool][0] if tool in COUNTED_LISTS else IAM_LISTS.get(tool, "result")
    rows = body.get(field)
    if not isinstance(rows, list):
        q["invalid"] = True
        return "unverified"
    if tool == "search_opensearch_logs" and (body["collectionStatus"] == "empty") != (not rows):
        q["invalid"] = True
        return "unverified"
    if tool in COUNTED_LISTS:
        total = body.get(COUNTED_LISTS[tool][1])
        if not count(total) or total < len(rows):
            q["invalid"] = True
            return "unverified"
        if total > len(rows):
            q["truncated"] = True
        if tool == "search_opensearch_logs" and "count" in body and (
                not count(body["count"]) or body["count"] != len(rows)):
            q["invalid"] = True
            return "unverified"
    return "success" if rows else "empty"


def text(value, limit=4096):
    return isinstance(value, str) and 0 < len(value) <= limit


def ip(value):
    if not text(value, 64):
        return False
    try:
        ip_address(value)
        return True
    except ValueError:
        return False


def bounded_list(value, limit, q):
    if not isinstance(value, list):
        return None
    if len(value) > limit:
        q["truncated"] = True
        return None
    return value


def source_collection(body, q, key="collectionStatus"):
    """Only for producers whose legacy output erased upstream collection evidence."""
    if key not in body:
        restricted = bool(incomplete(q))
        q["unknown"] = True
        return "partial" if restricted else "unverified"
    status = body[key]
    if status == "unknown":
        q["unknown"] = True
        return "unverified"
    if status == "partial":
        q["partial"] = True
        return "partial"
    if status == "error":
        return "error"
    if status not in ("ok", "empty"):
        q["invalid"] = True
        return "unverified"
    return None


def network_evidence(body, tool, q):
    def identity(row):
        return (isinstance(row, dict) and matching(row.get("eniId"), r"eni-[a-zA-Z0-9-]{1,64}")
                and matching(row.get("vpcId"), r"vpc-[a-zA-Z0-9-]{1,64}")
                and matching(row.get("subnetId"), r"subnet-[a-zA-Z0-9-]{1,64}")
                and ip(row.get("privateIp")))
    if tool == "find_ip_address":
        rows = bounded_list(body.get("enis"), 10, q)
        if (rows is None or not ip(body.get("ip")) or ip_address(body["ip"]).version != 4
                or not count(body.get("count")) or body["count"] != len(rows)):
            return None
        if not all(identity(row) for row in rows):
            return None
        if len(rows) == 10 and "truncated" not in body:
            q["unknown"] = True  # this producer silently slices at ten matches
        return "success" if rows else "empty"
    selection = body.get("routeSelection")
    if (not identity(body) or body.get("partial") is not False or body.get("unknown") != []
            or not all(isinstance(body.get(k), list) for k in ("securityGroups", "nacl", "routes"))
            or not matching(body.get("naclId"), r"acl-[a-zA-Z0-9-]{1,64}")
            or not matching(body.get("routeTableId"), r"rtb-[a-zA-Z0-9-]{1,64}")
            or not isinstance(selection, dict) or selection.get("status") != "selected"
            or selection.get("basis") not in ("explicit", "main")):
        return None
    return "success"  # configuration evidence, not a connectivity/health verdict


def topology_evidence(body, q):
    nodes = bounded_list(body.get("nodes"), 500, q)
    edges = bounded_list(body.get("edges"), 1000, q)
    collection = q.get("collection", {})
    selection, truncation = body.get("selection"), body.get("truncation")
    if (body.get("class") not in ("flow", "infra", "trace") or nodes is None or edges is None
            or not count(body.get("node_count")) or body["node_count"] != len(nodes)
            or not count(body.get("edge_count")) or body["edge_count"] != len(edges)
            or not isinstance(selection, dict) or not isinstance(truncation, dict)
            or collection.get("status") not in ("ok", "empty") or collection.get("stale") is not False
            or not text(collection.get("captured_at"), 40)):
        return None
    for key, cap, rows in (("nodes", 500, nodes), ("edges", 1000, edges)):
        limit = truncation.get("node_limit" if key == "nodes" else "edge_limit")
        if type(truncation.get(key)) is not bool or not count(limit) or not 0 < limit <= cap or len(rows) > limit:
            return None
    for key in ("sources", "publishedSources") if body["class"] != "trace" else ("sources",):
        sources = collection.get(key)
        if not isinstance(sources, list) or not sources or not all(
                s.get("status") in ("ok", "empty") and text(s.get("sourceId"), 80) and count(s.get("itemCount"))
                for s in sources):
            return None
    if not all(isinstance(n, dict) and all(text(n.get(k)) for k in ("id", "kind", "label")) for n in nodes):
        return None
    ids = {n["id"] for n in nodes}
    if len(ids) != len(nodes) or not all(
            isinstance(e, dict) and text(e.get("source")) and text(e.get("target"))
            and e["source"] in ids and e["target"] in ids and text(e.get("rel"), 128) for e in edges):
        return None
    if selection.get("status") == "resolved":
        if not text(selection.get("resolved_id")) or selection["resolved_id"] not in ids:
            return None
    elif selection.get("status") != "all":
        return None
    if collection["status"] == "empty":
        return "empty" if not nodes and not edges else None
    return "success" if nodes else None


def notion_evidence(body, tool, q):
    def identified(row, objects):
        return (isinstance(row, dict) and row.get("object") in objects
                and matching(row.get("id"), r"(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})", 36))
    if tool == "notion_fetch_page":
        if "blocks_error" in body:
            if isinstance(body["blocks_error"], str) and body["blocks_error"]:
                q["partial"] = True
            else:
                q["invalid"] = True
        verdict = source_collection(body, q)
        if verdict is not None:
            return verdict
        if body["collectionStatus"] != "ok" or not identified(body.get("page"), ("page",)):
            return "unverified"
        verdict = source_collection(body, q, "blocksCollectionStatus")
        if verdict is not None:
            q["partial"] = True
            return "partial"  # retrieved page metadata survives failed/unassessed child collection
        blocks = bounded_list(body.get("blocks"), 25, q)
        if (type(body.get("truncated")) is not bool or not identified(body.get("page"), ("page",))
                or blocks is None or not all(identified(b, ("block",)) and text(b.get("type"), 80) for b in blocks)):
            return None
        if (body["blocksCollectionStatus"] == "empty") != (not blocks):
            return "unverified"
        return "success"  # a fetched page with zero child blocks is still useful page evidence
    if "has_more" in body:
        if type(body["has_more"]) is bool:
            if body["has_more"]:
                q["truncated"] = True
        else:
            q["invalid"] = True
    cursor = body.get("next_cursor")
    if cursor is not None:
        if text(cursor):
            q["truncated"] = True
        else:
            q["invalid"] = True
    verdict = source_collection(body, q)
    if verdict is not None:
        return verdict
    rows = bounded_list(body.get("results"), 25, q)
    if rows is None or type(body.get("has_more")) is not bool or not all(identified(r, ("page", "database")) for r in rows):
        return None
    if (body["collectionStatus"] == "empty") != (not rows):
        return "unverified"
    return "success" if rows else "empty"


def metric_trace_evidence(body, tool, q):
    if tool in NAMED_LISTS or tool in METRIC_QUERIES | LOKI_QUERIES or tool == "tempo_search":
        verdict = source_collection(body, q)
        if verdict is not None:
            return verdict
    if type(body.get("truncated")) is not bool:
        return None
    if tool in NAMED_LISTS:
        field, limit, kind = NAMED_LISTS[tool]
        rows = bounded_list(body.get(field), limit, q)
        if rows is not None and all(isinstance(r, kind) for r in rows):
            if (body["collectionStatus"] == "empty") != (not rows):
                return "unverified"
            return "success" if rows else "empty"
        return None
    if tool in METRIC_QUERIES | LOKI_QUERIES:
        rows = bounded_list(body.get("result"), 50, q)
        kind = body.get("resultType")
        allowed = ("streams", "vector", "matrix") if tool in LOKI_QUERIES else ("vector", "matrix")
        if rows is None or kind not in allowed:
            return None
        if (body["collectionStatus"] == "empty") != (not rows):
            return "unverified"
        samples = 0
        for row in rows:
            if kind == "streams":
                labels = row.get("stream") if isinstance(row, dict) else None
                values = bounded_list(row.get("values"), 200, q) if isinstance(row, dict) else None
                if (not isinstance(labels, dict) or not all(isinstance(v, str) for v in labels.values())
                        or not values or not all(isinstance(v, list) and len(v) == 2
                        and matching(v[0], r"\d{1,20}") and isinstance(v[1], str)
                        and len(v[1].encode("utf-8")) <= 4096 for v in values)):
                    return None
                samples += len(values)
                if samples > 5000:
                    q["truncated"] = True
                    return None
                continue
            if not isinstance(row, dict) or not isinstance(row.get("metric"), dict):
                return None
            values = [row.get("value")] if kind == "vector" else bounded_list(row.get("values"), 500, q)
            if values is None:
                return None
            samples += len(values)
            if samples > 5000:
                q["truncated"] = True
                return None
            if not all(isinstance(v, list) and len(v) == 2 and number(v[0]) and text(v[1], 128) for v in values):
                return None
        return "success" if rows else "empty"
    if tool == "tempo_search":
        traces = bounded_list(body.get("traces"), 50, q)
        if traces is not None and all(isinstance(t, dict) and matching(t.get("traceID"), r"[a-fA-F0-9]+") for t in traces):
            if (body["collectionStatus"] == "empty") != (not traces):
                return "unverified"
            return "success" if traces else "empty"
        return None
    # Tempo's current get-trace fixture/producer uses OTLP batches. Other pass-through
    # encodings remain unverified; inspect only bounded structure, never span attributes.
    batches = bounded_list(body.get("batches"), 50, q)
    if batches is None:
        return None
    scopes_seen = spans_seen = 0
    for batch in batches:
        if not isinstance(batch, dict):
            return None
        scopes = bounded_list(batch.get("scopeSpans", batch.get("instrumentationLibrarySpans")), 200, q)
        if scopes is None:
            return None
        scopes_seen += len(scopes)
        if scopes_seen > 200:
            q["truncated"] = True
            return None
        for scope in scopes:
            if not isinstance(scope, dict):
                return None
            spans = bounded_list(scope.get("spans"), 5000, q)
            if spans is None:
                return None
            spans_seen += len(spans)
            if spans_seen > 5000:
                q["truncated"] = True
                return None
            if not all(isinstance(s, dict) and text(s.get("traceId"), 128) and text(s.get("spanId"), 128) for s in spans):
                return None
    return "success" if spans_seen else "empty"


def producer_evidence(body, tool, q):
    """Curated producer shapes only; no arbitrary nested error/key searching."""
    name = tool.rsplit("___", 1)[-1]
    if name in ASYNC_QUERY_TOOLS:
        return query_evidence(body, name, q)
    if name in ("query_inventory", "inventory_summary"):
        return inventory_evidence(body, name, q)
    if name == "get_rightsizing_recommendations":
        return rightsizing_evidence(body, q)
    if name in SHALLOW_TOOLS:
        return shallow_evidence(body, name, q)
    if name in ("find_ip_address", "get_eni_details"):
        return network_evidence(body, name, q)
    if name == "get_topology":
        return topology_evidence(body, q)
    if name in ("notion_search", "notion_query_database", "notion_fetch_page"):
        return notion_evidence(body, name, q)
    if name in METRIC_QUERIES | LOKI_QUERIES | set(NAMED_LISTS) | {"tempo_search", "tempo_get_trace"}:
        return metric_trace_evidence(body, name, q)
    return None


def terminal(result, ignored_texts=(), tool=""):
    if result.get("status") == "error":
        return "error", {}, {}
    if result.get("status") != "success":
        return "unverified", {}, {}
    content = result.get("content")
    if not isinstance(content, list):
        return "unverified", {"invalid": True}, {}
    object_producer = tool.rsplit("___", 1)[-1] in ASYNC_QUERY_TOOLS | SHALLOW_TOOLS | POSITIVE_TOOLS | {
        "query_inventory", "inventory_summary", "get_rightsizing_recommendations",
    }
    if not content:
        return "unverified", {"unknown": True}, {}
    outcomes, q, observed = [], {}, {}
    # Scan bounded content; language-hook reminders are non-JSON and not evidence.
    for block in content[:16]:
        if not isinstance(block, dict) or len(block) != 1 or not ({"json", "text"} & block.keys()):
            q["unsupported"] = True
            outcomes.append("unverified")
            continue
        raw = block.get("json", block.get("text"))
        if "text" in block and isinstance(raw, str) and raw in ignored_texts:
            continue  # the existing language hook's fixed reminder, not tool evidence
        try:
            body = raw if "json" in block else decode(raw)
            if isinstance(body, dict) and "statusCode" in body:
                if type(body["statusCode"]) is not int:
                    outcomes.append("unverified")
                    continue
                if body["statusCode"] >= 400:
                    outcomes.append("error")
                    continue
                if not 200 <= body["statusCode"] < 300:
                    outcomes.append("unverified")
                    continue
                body = decode(body.get("body"))
            if isinstance(body, dict):
                projected = quality(body)
                producer_outcome = producer_evidence(body, tool, projected)
                for key in ("partial", "unknown", "truncated", "invalid", "unsupported"):
                    if q.get(key) is True:
                        projected[key] = True
                q.update(projected)
                observed.update(scope(body.get("observedScope")))  # never infer from request/account defaults
                if body.get("error") or body.get("isError") is True:
                    outcomes.append("error")
                elif producer_outcome is not None:
                    outcomes.append("partial" if producer_outcome in ("success", "empty") and incomplete(q)
                                    else producer_outcome)
                elif incomplete(q):
                    outcomes.append("partial")
                else:
                    outcomes.append("unverified")
            elif isinstance(body, list):
                if object_producer:
                    q["invalid"] = True
                outcomes.append("unverified")
            else:
                q["unsupported"] = True
                outcomes.append("unverified")
        except (ValueError, TypeError, AttributeError, RecursionError):
            # Unknown oversized/malformed data is never successful evidence.
            q["invalid"] = True
            outcomes.append("unverified")
    if len(content) > 16:
        q["truncated"] = True
        outcomes.append("unverified")
    return combined(outcomes), q, observed


class ReceiptTracker:
    def __init__(self, ignored_texts=()):
        self.calls = {}
        self.truncated = False
        self.ignored_texts = tuple(ignored_texts)

    def observe(self, event):
        now = int(time.time() * 1000)
        message = event.get("message")
        blocks = message.get("content", []) if isinstance(message, dict) else []
        if not isinstance(blocks, list):
            blocks = []
        uses = [event.get("current_tool_use")] + [
            b.get("toolUse") for b in blocks if isinstance(b, dict)]
        for use in uses:
            if not isinstance(use, dict):
                continue
            tid, name = use.get("toolUseId"), use.get("name")
            if not matching(tid, r"[a-zA-Z0-9_-]+") or not matching(name, r"[a-zA-Z0-9_-]+"):
                self.truncated = True
                continue
            if tid not in self.calls:
                if len(self.calls) >= MAX_CALLS:
                    self.truncated = True
                    continue
                self.calls[tid] = {"version": 1, "callId": tid, "tool": name, "observedAt": now,
                                   "outcome": "unfinished", "inputs": {}, "requestedScope": {}, "observedScope": {}}
            receipt = self.calls[tid]
            # Only completed model toolUse messages supply final inputs, not streamed fragments.
            if isinstance(use.get("input"), dict):
                inputs = safe_inputs(use["input"])
                receipt["inputs"] = inputs
                receipt["requestedScope"] = scope({
                    "accountId": inputs.get("target_account_id", inputs.get("account_id")),
                    "region": inputs.get("region"), "resourceId": inputs.get("resource_id", inputs.get("eni_id"))})
        for block in blocks:
            result = block.get("toolResult") if isinstance(block, dict) else None
            if not isinstance(result, dict):
                continue
            receipt = self.calls.get(result.get("toolUseId"))
            if receipt is None:
                self.truncated = True
                continue
            outcome, q, observed = terminal(result, self.ignored_texts, receipt["tool"])
            if receipt["tool"].endswith("get_topology") and "collection" not in q and outcome in ("success", "empty"):
                outcome = "unverified"
            receipt.update(outcome=outcome, terminalObservedAt=now, quality=q, observedScope=observed)

    def frames(self, completed=False):
        for receipt in self.calls.values():
            yield {"receipt": receipt}
        if self.truncated:
            yield {"evidenceTruncated": True}
        if completed:
            # Receipt-set delivery only; this does not certify successful tools or source freshness.
            yield {"completion": {"version": 1, "receiptCount": len(self.calls)}}
