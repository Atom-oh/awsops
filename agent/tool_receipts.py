"""Bounded logical-call receipts from public Strands messages; never save raw results.

Clocks observe stream delivery, including batched results, not execution duration.
These receipts do not audit internal SDK retries.
"""
import json
import math
import re
import time
from datetime import datetime

MAX_CALLS = 32
MAX_RESULT = 262144
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
    if states == {"error"}:
        return "error"
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
        if outcome in ("success", "empty"):
            # A filtered, current query may match zero even when the type has other rows.
            return "success" if resources else "empty"
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


def producer_evidence(body, tool, q):
    """Curated producer shapes only; no arbitrary nested error/key searching."""
    name = tool.rsplit("___", 1)[-1]
    if name in ("query_inventory", "inventory_summary"):
        return inventory_evidence(body, name, q)
    if name == "get_rightsizing_recommendations":
        return rightsizing_evidence(body, q)
    if name in ("notion_search", "notion_query_database") and "has_more" in body:
        if type(body["has_more"]) is bool:
            if body["has_more"]:
                q["truncated"] = True
        else:
            q["invalid"] = True
    if name == "notion_fetch_page" and "blocks_error" in body:
        if isinstance(body["blocks_error"], str) and body["blocks_error"]:
            q["partial"] = True
        else:
            q["invalid"] = True
    return None


def terminal(result, ignored_texts=(), tool=""):
    if result.get("status") == "error":
        return "error", {}, {}
    if result.get("status") != "success":
        return "unverified", {}, {}
    content = result.get("content")
    if not isinstance(content, list):
        return "unverified", {"invalid": True}, {}
    object_producer = tool.rsplit("___", 1)[-1] in {
        "query_inventory", "inventory_summary", "get_rightsizing_recommendations",
    }
    if not content:
        return ("unverified", {"unknown": True}, {}) if object_producer else ("empty", {}, {})
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
                elif (not body or body.get("collection", {}).get("status") == "empty"
                      or (body.get("enis") == [] and type(body.get("count")) is int and body["count"] == 0)
                      or any(body.get(k) == [] for k in ("items", "data", "rows", "results"))):
                    outcomes.append("empty")
                else:
                    outcomes.append("success")
            elif isinstance(body, list):
                if object_producer:
                    q["invalid"] = True
                    outcomes.append("unverified")
                else:
                    outcomes.append("success" if body else "empty")
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
            if receipt["tool"].endswith("get_topology") and "collection" not in q and outcome == "success":
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
