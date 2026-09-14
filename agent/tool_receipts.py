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
    """Explicit quality only. Invalid present fields taint; absent fields stay absent."""
    out = {}

    def fields(src, dest, rules):
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
    fields(body, out, {"partial": boolean})
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
                              "evidenceKind": one_of({"inventory", "trace"})})
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
                        "sourceId": lambda v: matching(v, r"(?:inventory:)?[a-z][a-z0-9_-]*", 80),
                        "scope": one_of({"account", "aggregate"}),
                        "producerStatus": one_of({"succeeded", "failed", "partial", "running", "unknown"}),
                        **{k: lambda v: v is None or number(v) for k in
                           ("capturedAtMs", "lastSuccessAtMs", "attemptedAtMs", "finishedAtMs", "itemCount")},
                    })
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
    if not isinstance(content, list):
        return "unverified", {"invalid": True}, {}
    if not content:
        return "empty", {}, {}
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
                for key in ("partial", "unknown", "truncated", "invalid", "unsupported"):
                    if q.get(key) is True:
                        projected[key] = True
                q.update(projected)
                observed.update(scope(body.get("observedScope")))  # never infer from request/account defaults
                if body.get("error") or body.get("isError") is True:
                    outcomes.append("error")
                elif incomplete(q):
                    outcomes.append("partial")
                elif (not body or body.get("collection", {}).get("status") == "empty"
                      or (body.get("enis") == [] and type(body.get("count")) is int and body["count"] == 0)
                      or any(body.get(k) == [] for k in ("items", "data", "rows", "results"))):
                    outcomes.append("empty")
                else:
                    outcomes.append("success")
            elif isinstance(body, list):
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

    def frames(self, completed=False):
        for receipt in self.calls.values():
            yield {"receipt": receipt}
        if self.truncated:
            yield {"evidenceTruncated": True}
        if completed:
            # Receipt-set delivery only; this does not certify successful tools or source freshness.
            yield {"completion": {"version": 1, "receiptCount": len(self.calls)}}
