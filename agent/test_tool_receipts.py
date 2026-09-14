"""Public Strands 1.41.0 messages, replayed offline through the real stream adapter."""
import asyncio
import json
from pathlib import Path
import unittest

from test_agent import agent, FakeStreamingAgent


def collect(events):
    async def run():
        return [event async for event in agent._stream_text(FakeStreamingAgent(events), "inspect")]
    return asyncio.run(run())


def use(call_id, **inputs):
    return {"message": {"role": "assistant", "content": [
        {"toolUse": {"toolUseId": call_id, "name": "network___inspect", "input": inputs}}
    ]}}


def result(call_id, body, status="success"):
    return {"message": {"role": "user", "content": [
        {"toolResult": {"toolUseId": call_id, "status": status, "content": [
            {"text": json.dumps(body)}
        ]}}
    ]}}


class ToolReceiptTest(unittest.TestCase):
    def test_complete_model_message_preserves_legacy_tool_event_without_streamed_fragments(self):
        frames = collect([use("a", eni_id="eni-0123"), result("a", {"id": "eni-0123"})])
        self.assertEqual([f["tool"] for f in frames if "tool" in f], ["network___inspect"])

    def test_successful_transport_does_not_certify_unknown_collection_or_empty_items(self):
        for body, expected in [
            ({"securityGroups": [], "routes": [], "partial": True, "unknown": [{"reason": "read_failed"}]}, "partial"),
            ({"items": [], "count": 0}, "empty"),
            ({"statusCode": 302, "body": "{}"}, "unverified"),
            ({"partial": False, "data": []}, "empty"),
        ]:
            receipts = [f["receipt"] for f in collect([use("a"), result("a", body)]) if "receipt" in f]
            self.assertEqual(receipts[0]["outcome"], expected)

    def test_selected_eni_route_is_successful_and_preserves_safe_basis(self):
        body = {"eniId": "eni-0123", "securityGroups": [], "routes": [], "partial": False,
                "unknown": [], "routeSelection": {"status": "selected", "basis": "main", "associations": ["SECRET"]}}
        receipts = [f["receipt"] for f in collect([use("a"), result("a", body)]) if "receipt" in f]
        self.assertEqual(receipts[0]["outcome"], "success")
        self.assertEqual(receipts[0]["quality"]["routeSelection"], {"status": "selected", "basis": "main"})
        self.assertNotIn("SECRET", json.dumps(receipts))

    def test_language_hook_reminder_is_not_evidence_but_unparsed_result_is_incomplete(self):
        for text, expected in [(agent.LANG_TOOL_REMINDER["en"], "success"), ("SECRET" * 60000, "partial")]:
            event = result("a", {"id": "eni-fixture"})
            event["message"]["content"][0]["toolResult"]["content"].append({"text": text})
            receipt = [f["receipt"] for f in collect([use("a"), event]) if "receipt" in f][0]
            self.assertEqual(receipt["outcome"], expected)

    def test_malformed_quality_never_crashes_or_certifies_evidence(self):
        frames = collect([use("a"), result("a", {"nodes": [1], "collection": {
            "status": {"credential": "SECRET"}, "sources": [{"status": []}],
        }})])
        receipts = [f["receipt"] for f in frames if "receipt" in f]
        self.assertEqual(len(receipts), 1)
        self.assertNotEqual(receipts[0]["outcome"], "success")
        self.assertNotIn("SECRET", json.dumps(receipts))

    def test_truncated_content_cannot_hide_a_failure_after_a_success(self):
        event = result("a", {"id": "eni-fixture"})
        event["message"]["content"][0]["toolResult"]["content"] += [
            {"text": json.dumps({"statusCode": 500, "body": "SECRET"})}
        ] * 17
        receipts = [f["receipt"] for f in collect([use("a"), event]) if "receipt" in f]
        self.assertEqual(receipts[0]["outcome"], "partial")

    def test_actual_public_fixture_correlates_repeated_names_without_private_events(self):
        events = json.loads((Path(__file__).parent / "fixtures/strands-1.41-public-stream.json").read_text())
        frames = collect(events)
        receipts = [f["receipt"] for f in frames if "receipt" in f]
        self.assertEqual([r["callId"] for r in receipts], ["call-0", "call-1"])
        self.assertEqual([r["outcome"] for r in receipts], ["success", "success"])
        self.assertEqual([r["inputs"] for r in receipts], [
            {"resource_id": "eni-fixture-one"}, {"resource_id": "eni-fixture-two"}])
        for receipt in receipts:
            self.assertEqual(receipt["version"], 1)
            self.assertGreaterEqual(receipt["terminalObservedAt"], receipt["observedAt"])
            self.assertEqual(receipt["observedScope"], {})
            self.assertNotIn("durationMs", receipt)

    def test_terminal_failure_partial_and_unfinished_do_not_become_success(self):
        frames = collect([
            use("a"), use("b"), use("c"), use("d"), use("e"),
            result("b", {"statusCode": 403, "body": "Bearer SECRET"}),
            result("a", {"id": "eni-fixture", "partial": True, "unknown": [{"reason": "SECRET"}]}),
            result("c", {"error": "SECRET"}, status="error"),
            result("d", []),
        ])
        receipts = {f["receipt"]["callId"]: f["receipt"] for f in frames if "receipt" in f}
        self.assertEqual({k: v["outcome"] for k, v in receipts.items()},
                         {"a": "partial", "b": "error", "c": "error", "d": "empty", "e": "unfinished"})
        self.assertNotIn("SECRET", json.dumps(receipts))

    def test_requested_scope_is_not_observed_and_only_safe_inputs_survive(self):
        frames = collect([use("a", target_account_id="123456789012", region="us-east-1",
                              resource_id="eni-0123", query="SELECT " + "SECRET" * 10000,
                              Authorization="Bearer SECRET", url="https://user:SECRET@host/"),
                          result("a", {"id": "eni-0123", "partial": False})])
        receipts = [f["receipt"] for f in frames if "receipt" in f]
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0]["requestedScope"], {"accountId": "123456789012", "region": "us-east-1",
                                                       "resourceId": "eni-0123"})
        self.assertEqual(receipts[0]["observedScope"], {})
        self.assertNotIn("SECRET", json.dumps(receipts))
        self.assertLess(len(json.dumps(receipts)), 2000)

    def test_topology_attempt_and_publication_clocks_remain_distinct(self):
        source = {"sourceId": "inventory:ec2_instance", "status": "error", "scope": "account",
                  "capturedAtMs": 1000, "lastSuccessAtMs": 2000, "attemptedAtMs": 3000,
                  "finishedAtMs": 4000, "reasons": ["source_failed"], "secret": "SECRET"}
        published = {**source, "status": "ok", "capturedAtMs": 500}
        collection = {"status": "error", "stale": True, "retainedPrevious": True,
                      "captured_at": "2026-09-14T01:00:00Z", "attempted_at": "2026-09-14T02:00:00Z",
                      "sources": [source], "publishedSources": [published]}
        frames = collect([use("a"), result("a", {
            "nodes": [{"id": "SECRET"}], "collection": collection,
            "selection": {"status": "resolved"}, "truncation": {"nodes": True, "edges": False}})])
        receipts = [f["receipt"] for f in frames if "receipt" in f]
        self.assertEqual(len(receipts), 1)
        quality = receipts[0]["quality"]
        self.assertEqual(receipts[0]["outcome"], "partial")
        self.assertTrue(quality["collection"]["retainedPrevious"])
        self.assertEqual(quality["collection"]["sources"][0]["capturedAtMs"], 1000)
        self.assertEqual(quality["collection"]["publishedSources"][0]["capturedAtMs"], 500)
        self.assertEqual(quality["collection"]["captured_at"], "2026-09-14T01:00:00Z")
        self.assertEqual(quality["selection"], "resolved")
        self.assertTrue(quality["truncation"]["nodes"])
        self.assertNotIn("SECRET", json.dumps(receipts))

    def test_oversized_result_is_unverified_and_receipts_are_bounded(self):
        frames = collect([use("a"), result("a", {"data": "x" * 300000})])
        receipts = [f["receipt"] for f in frames if "receipt" in f]
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0]["outcome"], "unverified")
        many = collect([use(f"call-{i}") for i in range(100)])
        self.assertLessEqual(len([f for f in many if "receipt" in f]), 32)
        self.assertTrue(any(f.get("evidenceTruncated") for f in many))


class ReviewReceiptTest(unittest.TestCase):
    def test_public_result_contract_variants(self):
        cases = json.loads((Path(__file__).parent / "fixtures/task4-receipt-cases.json").read_text())
        for case in cases:
            with self.subTest(case=case["name"]):
                start = use("a")
                start["message"]["content"][0]["toolUse"]["name"] = case.get("tool", "network___inspect")
                end = result("a", {})
                end["message"]["content"][0]["toolResult"]["content"] = case["content"]
                frames = collect([start, end, {"data": "answer"}])
                receipt = next(f["receipt"] for f in frames if "receipt" in f)
                self.assertEqual(receipt["outcome"], case["outcome"])
                if case.get("marker"):
                    self.assertTrue(receipt["quality"].get(case["marker"]))
                if case.get("expectedSourceId"):
                    collection = receipt["quality"]["collection"]
                    self.assertEqual(collection["sources"][0]["sourceId"], case["expectedSourceId"])
                    self.assertEqual([collection["windowStartMs"], collection["windowEndMs"]], case["expectedWindow"])
                self.assertNotIn("PRIVATE", json.dumps(frames))

    def test_completion_follows_all_same_tool_receipts_including_unfinished(self):
        frames = collect([use("a"), use("b"), result("a", {"id": "eni-0123"})])
        self.assertEqual(frames[-1], {"completion": {"version": 1, "receiptCount": 2}})
        self.assertEqual([f["receipt"]["outcome"] for f in frames if "receipt" in f], ["success", "unfinished"])

    def test_failed_invocation_retains_receipts_but_has_no_completion(self):
        class Interrupted:
            async def stream_async(self, _):
                yield use("a")
                yield use("b")
                yield result("a", {"id": "eni-0123"})
                raise RuntimeError("PRIVATE")
        frames = []

        async def run():
            with self.assertRaises(RuntimeError):
                async for frame in agent._stream_text(Interrupted(), "inspect"):
                    frames.append(frame)
        asyncio.run(run())
        self.assertFalse(any("completion" in f for f in frames))
        self.assertEqual(frames[-1], {"runtimeOutcome": "error"})
        self.assertEqual([f["receipt"]["outcome"] for f in frames if "receipt" in f], ["success", "unfinished"])
        self.assertNotIn("PRIVATE", json.dumps(frames))
