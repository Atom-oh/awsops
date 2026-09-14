"""Bounded logical-call receipts from public Strands messages; never save raw results.

Clocks observe stream delivery, including batched results, not execution duration.
These receipts do not audit internal SDK retries.
"""
import json
import math
import re
import time

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
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 9007199254740991


def quality(body):
    """Explicit quality only. Publication and original-source clocks keep producer names."""
    out = {}
    for key in ("partial",):
        if type(body.get(key)) is bool:
            out[key] = body[key]
    if "unknown" in body:
        out["unknown"] = bool(body["unknown"])
    selection = body.get("selection")
    if isinstance(selection, dict) and selection.get("status") in {"all", "resolved", "not_found", "ambiguous"}:
        out["selection"] = selection["status"]
    route = body.get("routeSelection")
    if isinstance(route, dict):
        out["routeSelection"] = {"status": "selected" if route.get("status") == "selected" else "unknown"}
        if route.get("basis") in ("explicit", "main"):
            out["routeSelection"]["basis"] = route["basis"]
        if isinstance(route.get("reason"), str) and route["reason"] in REASONS:
            out["routeSelection"]["reason"] = route["reason"]
    trunc = body.get("truncation")
    if isinstance(trunc, dict):
        out["truncation"] = {k: trunc[k] for k in ("nodes", "edges") if type(trunc.get(k)) is bool}
        for k in ("node_limit", "edge_limit"):
            if number(trunc.get(k)):
                out["truncation"][k] = trunc[k]
    coll = body.get("collection")
    if isinstance(coll, dict):
        c = {"status": coll.get("status") if coll.get("status") in STATUS else "unknown"}
        for k in ("stale", "retainedPrevious", "snapshotConsistent"):
            if type(coll.get(k)) is bool:
                c[k] = coll[k]
        for k in ("captured_at", "attempted_at"):
            if coll.get(k) is None or matching(coll.get(k), r"\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?", 40):
                c[k] = coll.get(k)
        if coll.get("evidenceKind") in ("inventory", "trace"):
            c["evidenceKind"] = coll["evidenceKind"]
        for key in ("sources", "publishedSources"):
            if key not in coll:
                continue
            raw = coll[key]
            c[key] = []
            if not isinstance(raw, list):
                out["truncated"] = True
                continue
            if len(raw) > 8:
                out["truncated"] = True
            for source in raw[:8]:
                if not isinstance(source, dict):
                    out["truncated"] = True
                    continue
                s = {"status": source.get("status") if source.get("status") in STATUS else "unknown"}
                if matching(source.get("sourceId"), r"(?:inventory:)?[a-z][a-z0-9_-]*", 80):
                    s["sourceId"] = source["sourceId"]
                if source.get("scope") in ("account", "aggregate"):
                    s["scope"] = source["scope"]
                if source.get("producerStatus") in ("succeeded", "failed", "partial", "running", "unknown"):
                    s["producerStatus"] = source["producerStatus"]
                for k in ("capturedAtMs", "lastSuccessAtMs", "attemptedAtMs", "finishedAtMs", "itemCount"):
                    if source.get(k) is None or number(source.get(k)):
                        s[k] = source.get(k)
                if isinstance(source.get("reasons"), list):
                    s["reasons"] = [r for r in source["reasons"][:6] if isinstance(r, str) and r in REASONS]
                c[key].append(s)
        out["collection"] = c
    return out


def incomplete(q):
    coll = q.get("collection", {})
    return (q.get("partial") or q.get("unknown") or q.get("truncated")
            or q.get("selection") in ("not_found", "ambiguous")
            or q.get("routeSelection", {}).get("status") == "unknown"
            or any(q.get("truncation", {}).get(k) is True for k in ("nodes", "edges"))
            or coll.get("stale") or coll.get("retainedPrevious") or coll.get("snapshotConsistent") is False
            or (bool(coll) and coll.get("status") not in ("ok", "empty"))
            or any(s["status"] not in ("ok", "empty")
                   for key in ("sources", "publishedSources") for s in coll.get(key, [])))


def decode(value):
    if isinstance(value, str):
        if len(value) > MAX_RESULT:
            raise ValueError("oversized")
        return json.loads(value)
    return value


def terminal(result, ignored_texts=()):
    if result.get("status") == "error":
        return "error", {}, {}
    if result.get("status") != "success":
        return "unverified", {}, {}
    content = result.get("content")
    if not isinstance(content, list) or not content:
        return "empty", {}, {}
    outcomes, q, observed = [], {}, {}
    # Scan bounded content; language-hook reminders are non-JSON and not evidence.
    for block in content[:16]:
        if not isinstance(block, dict):
            continue
        raw = block.get("json", block.get("text"))
        if isinstance(raw, str) and raw in ignored_texts:
            continue  # the existing language hook's fixed reminder, not tool evidence
        try:
            body = decode(raw)
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
                q.update(quality(body))
                observed.update(scope(body.get("observedScope")))  # never infer from request/account defaults
                if body.get("error") or body.get("isError") is True:
                    outcomes.append("error")
                elif incomplete(q):
                    outcomes.append("partial")
                elif (not body or body.get("collection", {}).get("status") == "empty"
                      or any(body.get(k) == [] for k in ("items", "data", "rows", "results"))):
                    outcomes.append("empty")
                else:
                    outcomes.append("success")
            elif isinstance(body, list):
                outcomes.append("success" if body else "empty")
        except (ValueError, TypeError, AttributeError, RecursionError):
            # Unknown oversized/malformed data is never successful evidence.
            outcomes.append("unverified")
    if len(content) > 16:
        q["truncated"] = True
        outcomes.append("unverified")
    if "error" in outcomes:
        outcome = "partial" if "success" in outcomes or "partial" in outcomes else "error"
    elif "partial" in outcomes:
        outcome = "partial"
    elif "success" in outcomes:
        outcome = "partial" if "unverified" in outcomes else "success"
    elif "unverified" in outcomes or not outcomes:
        outcome = "unverified"
    else:
        outcome = "empty"
    return outcome, q, observed


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
            outcome, q, observed = terminal(result, self.ignored_texts)
            if receipt["tool"].endswith("get_topology") and "collection" not in q and outcome == "success":
                outcome = "unverified"
            receipt.update(outcome=outcome, terminalObservedAt=now, quality=q, observedScope=observed)

    def frames(self):
        for receipt in self.calls.values():
            yield {"receipt": receipt}
        if self.truncated:
            yield {"evidenceTruncated": True}
