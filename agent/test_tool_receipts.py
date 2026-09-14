"""Public Strands 1.41.0 messages, replayed offline through the real stream adapter."""
import asyncio
import copy
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


def inventory_row(freshness="healthy", count=0, **changes):
    """Shape of inventory_read_mcp._sync_freshness(), without database access."""
    stamp = "2026-09-14T00:00:00+00:00"
    return {
        "resource_type": "ec2", "status": "succeeded", "finished_at": stamp,
        "row_count": count, "current_count": count, "last_success_at": stamp,
        "last_success_row_count": count, "unknown_attribute_count": 0,
        "oldest_captured_at": stamp if count else None, "latest_success_at": stamp,
        "freshness": freshness, "age_minutes": 0, "stale_after_minutes": 30,
        **changes,
    }


def rightsizing_service(count=0, **changes):
    """Shape of aws_finops_mcp._rightsizing_result()."""
    return {"count": count, "recommendations": [
        {"instanceArn": "PRIVATE", "estimatedMonthlySavings": 12.5, "currency": "USD"}
    ] * count, "truncated": False, "errors": [], **changes}


class ProducerReceiptTest(unittest.TestCase):
    def receipt(self, tool, body):
        start = use("a", query="PRIVATE")
        start["message"]["content"][0]["toolUse"]["name"] = "producer___" + tool
        frames = collect([start, result("a", {"statusCode": 200, "body": json.dumps(body)})])
        self.assertEqual(frames[-1], {"completion": {"version": 1, "receiptCount": 1}})
        receipt = next(f["receipt"] for f in frames if "receipt" in f)
        self.assertNotIn("PRIVATE", json.dumps(receipt))
        self.assertLess(len(json.dumps(receipt)), 6500)
        return receipt

    def test_inventory_distinguishes_confirmed_empty_from_unavailable_and_retained_data(self):
        for freshness, count, expected in [
            ("healthy", 0, "empty"), ("healthy", 1, "success"),
            ("degraded", 0, "partial"), ("degraded", 1, "partial"),
            ("stale", 0, "partial"), ("stale", 1, "partial"),
            ("unavailable", 0, "unverified"), ("unavailable", 1, "partial"),
        ]:
            with self.subTest(freshness=freshness, count=count):
                row = inventory_row(freshness, count)
                if freshness == "unavailable":
                    row.update(status=None, last_success_at=None, latest_success_at=None)
                body = {"resource_type": "ec2", "resources": [{"id": "PRIVATE"}] * count,
                        "count": count, "freshness": row}
                receipt = self.receipt("query_inventory", body)
                self.assertEqual(receipt["outcome"], expected)
                source = receipt["quality"]["collection"]["sources"][0]
                self.assertEqual(source["sourceId"], "inventory:ec2")
                self.assertEqual(source["itemCount"], count)
                self.assertEqual(receipt["quality"]["collection"].get("stale", False), freshness == "stale")

    def test_inventory_summary_uses_current_count_not_latest_attempt_row_count(self):
        row = inventory_row(count=5, row_count=0)
        receipt = self.receipt("inventory_summary", {"sync": [row], "note": "PRIVATE"})
        self.assertEqual(receipt["outcome"], "success")
        self.assertEqual(receipt["quality"]["collection"]["sources"][0]["itemCount"], 5)

    def test_inventory_summary_handles_mixed_and_wholly_failed_sources(self):
        failed = inventory_row("unavailable", status="failed", last_success_at=None, latest_success_at=None)
        for rows, expected in [
            ([], "unverified"), ([inventory_row()], "empty"), ([failed], "error"),
            ([failed, inventory_row()], "partial"), ([failed, inventory_row(count=2)], "partial"),
            ([inventory_row("stale")], "partial"),
        ]:
            with self.subTest(rows=rows):
                self.assertEqual(self.receipt("inventory_summary", {"sync": rows})["outcome"], expected)

    def test_inventory_missing_malformed_and_contradictory_markers_never_certify_empty(self):
        for changes in [
            {"freshness": None}, {"freshness": {"PRIVATE": True}}, {"freshness": "future"},
            {"current_count": None}, {"current_count": True}, {"current_count": -1},
            {"status": "failed"}, {"unknown_attribute_count": 1}, {"unknown_attribute_count": None},
            {"last_success_at": None}, {"age_minutes": "PRIVATE"}, {"latest_success_at": "PRIVATE"},
        ]:
            with self.subTest(changes=changes):
                receipt = self.receipt("query_inventory", {
                    "count": 0, "resources": [], "freshness": inventory_row(**changes),
                })
                self.assertNotIn(receipt["outcome"], ("empty", "success"))
        for body in [
            {"count": 0, "resources": []},
            {"count": 0, "resources": [], "freshness": None},
            {"count": 0, "resources": {}, "freshness": inventory_row()},
            {"count": 1, "resources": [], "freshness": inventory_row()},
            {"sync": None},
        ]:
            tool = "inventory_summary" if "sync" in body else "query_inventory"
            self.assertNotIn(self.receipt(tool, body)["outcome"], ("empty", "success"))

    def test_inventory_optional_markers_and_filtered_empty_are_not_false_failures(self):
        row = {"resource_type": "cloudfront", "freshness": "healthy", "current_count": 5}
        receipt = self.receipt("query_inventory", {
            "resource_type": "cloudfront", "resource_id": "E123456", "projection": "identity_only",
            "count": 0, "resources": [], "freshness": row,
        })
        self.assertEqual(receipt["outcome"], "empty")

    def test_unfiltered_inventory_limit_does_not_certify_full_or_empty_coverage(self):
        for returned in (0, 2):
            with self.subTest(returned=returned):
                receipt = self.receipt("query_inventory", {
                    "resource_type": "ec2", "count": returned,
                    "resources": [{"id": "PRIVATE"}] * returned,
                    "freshness": inventory_row(count=3),
                })
                self.assertEqual(receipt["outcome"], "partial")
                self.assertTrue(receipt["quality"]["truncated"])

    def test_inventory_summary_source_projection_is_bounded_and_does_not_visit_tail(self):
        row = inventory_row(count=1, resource_type="ec2", note="PRIVATE")
        receipt = self.receipt("inventory_summary", {"sync": [row] * 9 + [{"error": "PRIVATE"}] * 1000})
        self.assertEqual(receipt["outcome"], "partial")
        self.assertTrue(receipt["quality"]["truncated"])
        self.assertLessEqual(len(receipt["quality"]["collection"]["sources"]), 8)

    def test_rightsizing_partial_and_wholly_failed_services(self):
        for results, resource_type, total, expected in [
            ({"ec2": {"error": "PRIVATE"}}, "ec2", None, "error"),
            ({s: {"error": "PRIVATE"} for s in ("ec2", "rds", "ecs", "lambda")}, "all", None, "error"),
            ({"ec2": rightsizing_service(), "rds": {"error": "PRIVATE"},
              "ecs": rightsizing_service(), "lambda": rightsizing_service()}, "all", None, "partial"),
            ({"ec2": rightsizing_service(1)}, "ec2", 12.5, "success"),
            ({"ec2": rightsizing_service()}, "ec2", 0, "empty"),
            ({"ec2": rightsizing_service(1)}, "ec2", None, "partial"),
            ({"ec2": rightsizing_service(1, errors=[{"message": "PRIVATE"}])}, "ec2", None, "partial"),
            ({"ec2": rightsizing_service(errors=[{"message": "PRIVATE"}])}, "ec2", None, "error"),
            ({"ec2": rightsizing_service(truncated=True)}, "ec2", None, "partial"),
        ]:
            with self.subTest(results=results, expected=expected):
                receipt = self.receipt("get_rightsizing_recommendations", {
                    "resourceType": resource_type, "results": results,
                    "totalEstimatedMonthlySavings": total, "currency": "USD" if total else None,
                })
                self.assertEqual(receipt["outcome"], expected)
                if total is None:
                    self.assertTrue(receipt["quality"].get("unknown"))

    def test_rightsizing_malformed_or_omitted_markers_and_services_fail_conservatively(self):
        valid = {"resourceType": "ec2", "results": {"ec2": rightsizing_service()},
                 "totalEstimatedMonthlySavings": 0}
        for field, value in [("truncated", "false"), ("errors", None), ("errors", "PRIVATE"),
                             ("error", None), ("error", {}), ("count", True), ("count", 1),
                             ("recommendations", {}), ("recommendations", None)]:
            body = copy.deepcopy(valid)
            body["results"]["ec2"][field] = value
            with self.subTest(field=field, value=value):
                receipt = self.receipt("get_rightsizing_recommendations", body)
                self.assertNotIn(receipt["outcome"], ("empty", "success"))
                self.assertTrue(receipt["quality"].get("invalid"))
        for changes in [{"results": None}, {"results": {}}, {"resourceType": "all"},
                        {"totalEstimatedMonthlySavings": "PRIVATE"}, {"totalEstimatedMonthlySavings": True},
                        {"totalEstimatedMonthlySavings": None}]:
            self.assertNotIn(self.receipt("get_rightsizing_recommendations", {
                **valid, **changes,
            })["outcome"], ("empty", "success"))
        # The additive errors/truncated markers may be absent in an older valid response.
        body = copy.deepcopy(valid)
        del body["results"]["ec2"]["errors"]
        del body["results"]["ec2"]["truncated"]
        self.assertEqual(self.receipt("get_rightsizing_recommendations", body)["outcome"], "empty")

    def test_rightsizing_unknown_service_does_not_expand_projection(self):
        receipt = self.receipt("get_rightsizing_recommendations", {
            "resourceType": "ec2", "results": {
                "ec2": rightsizing_service(), "PRIVATE": {"error": "PRIVATE"},
            }, "totalEstimatedMonthlySavings": 0,
        })
        self.assertNotIn(receipt["outcome"], ("success", "empty"))
        self.assertTrue(receipt["quality"]["unsupported"])

    def test_connector_truncation_is_typed_sticky_and_not_raw_output(self):
        from tool_receipts import terminal
        for value, expected_marker in [(True, "truncated"), ("true", "invalid"), (None, "invalid")]:
            event = result("a", {"truncated": value, "result": [], "query": "PRIVATE"})
            raw = event["message"]["content"][0]["toolResult"]
            raw["content"].append({"json": {"truncated": False, "id": "PRIVATE"}})
            outcome, quality, _ = terminal(raw)
            self.assertEqual(outcome, "partial")
            self.assertTrue(quality[expected_marker])
            self.assertNotIn("PRIVATE", json.dumps(quality))

    def test_notion_children_failure_and_more_pages_preserve_partial_evidence(self):
        receipt = self.receipt("notion_fetch_page", {
            "page": {"id": "PRIVATE"}, "blocks": [], "truncated": False, "blocks_error": "(403) PRIVATE",
        })
        self.assertEqual(receipt["outcome"], "partial")
        for tool in ("notion_search", "notion_query_database"):
            for marker in (True, "false", None):
                receipt = self.receipt(tool, {"results": [], "has_more": marker, "next_cursor": "PRIVATE"})
                self.assertEqual(receipt["outcome"], "partial")

    def test_extreme_numeric_markers_do_not_crash_the_stream(self):
        for value in (10 ** 400, float("nan"), float("inf"), -1, True):
            with self.subTest(value=value):
                receipt = self.receipt("inventory_summary", {
                    "sync": [inventory_row(current_count=value)],
                })
                self.assertNotIn(receipt["outcome"], ("success", "empty"))
                self.assertTrue(receipt["quality"].get("invalid"))
                receipt = self.receipt("get_rightsizing_recommendations", {
                    "resourceType": "ec2", "results": {"ec2": rightsizing_service()},
                    "totalEstimatedMonthlySavings": value,
                })
                self.assertNotIn(receipt["outcome"], ("success", "empty"))

    def test_projection_does_not_walk_rows_errors_or_unknown_services(self):
        from tool_receipts import terminal

        class DoNotWalk(list):
            def __iter__(self):
                raise AssertionError("raw content must not be traversed")

        class DoNotRead(dict):
            def get(self, *args):
                raise AssertionError("summary tail must not be read")

        for tool, body in [
            ("query_inventory", {"resources": DoNotWalk([{"query": "PRIVATE"}]), "count": 1,
                                 "freshness": inventory_row(count=1)}),
            ("inventory_summary", {"sync": [inventory_row(count=1)] * 8 + [DoNotRead()]}),
            ("get_rightsizing_recommendations", {
                "resourceType": "ec2", "totalEstimatedMonthlySavings": None,
                "results": {"ec2": rightsizing_service(1, recommendations=DoNotWalk([{"arn": "PRIVATE"}]),
                                                       errors=DoNotWalk([{"error": "PRIVATE"}])),
                            "PRIVATE": DoNotRead()},
            }),
        ]:
            raw = {"status": "success", "content": [{"json": body}]}
            outcome, q, _ = terminal(raw, tool="producer___" + tool)
            self.assertIn(outcome, ("success", "partial"))
            self.assertNotIn("PRIVATE", json.dumps(q))

    def test_inventory_source_clocks_are_not_latest_attempt_clocks(self):
        row = inventory_row("degraded", count=1, status="failed",
                            finished_at="2026-09-14T02:00:00Z",
                            latest_success_at="2026-09-14T00:00:00Z",
                            last_success_at="2026-09-14T01:00:00Z")
        receipt = self.receipt("inventory_summary", {"sync": [row]})
        source = receipt["quality"]["collection"]["sources"][0]
        self.assertEqual(source["lastSuccessAtMs"] - source["capturedAtMs"], 3600000)
        self.assertEqual(source["finishedAtMs"] - source["lastSuccessAtMs"], 3600000)
        self.assertEqual(source["producerStatus"], "failed")
        self.assertEqual(receipt["outcome"], "partial")

    def test_confirmed_empty_and_failed_content_blocks_are_partial(self):
        from tool_receipts import terminal
        outcome, _, _ = terminal({"status": "success", "content": [
            {"json": []}, {"json": {"error": "PRIVATE"}},
        ]})
        self.assertEqual(outcome, "partial")

    def test_known_producers_require_their_object_envelope_to_confirm_empty(self):
        from tool_receipts import terminal
        for tool in ("query_inventory", "inventory_summary", "get_rightsizing_recommendations"):
            for content in ([], [{"json": []}], [{"json": {}}]):
                with self.subTest(tool=tool, content=content):
                    outcome, _, _ = terminal({"status": "success", "content": content},
                                             tool="producer___" + tool)
                    self.assertEqual(outcome, "unverified")

    def test_async_queries_require_terminal_success_before_confirming_results(self):
        for tool, complete, pending, failed in [
            ("get_logs_insight_query_results", "Complete", ("Scheduled", "Running", "Unknown"),
             ("Failed", "Cancelled", "Timeout")),
            ("get_query_results", "FINISHED", ("QUEUED", "RUNNING"),
             ("FAILED", "CANCELLED", "TIMED_OUT")),
        ]:
            for state, expected in [(complete, "empty"), *[(s, "unverified") for s in pending],
                                    *[(s, "error") for s in failed], ("future", "unverified")]:
                with self.subTest(tool=tool, state=state):
                    receipt = self.receipt(tool, {
                        "queryId": "PRIVATE", "status": state, "results": [], "count": 0, "nextToken": None,
                    })
                    self.assertEqual(receipt["outcome"], expected)
            receipt = self.receipt(tool, {"status": complete, "results": [{"message": "PRIVATE"}], "count": 1})
            self.assertEqual(receipt["outcome"], "success")

    def test_async_query_start_status_and_continuation_are_not_result_completion(self):
        for tool in ("execute_log_insights_query", "lake_query"):
            self.assertEqual(self.receipt(tool, {"queryId": "PRIVATE", "status": "STARTED"})["outcome"], "unverified")
        for state, expected in [("QUEUED", "unverified"), ("RUNNING", "unverified"),
                                ("FAILED", "error"), ("FINISHED", "success")]:
            self.assertEqual(self.receipt("get_query_status", {"status": state})["outcome"], expected)
        receipt = self.receipt("get_query_results", {
            "status": "FINISHED", "results": [], "count": 0, "nextToken": "PRIVATE",
        })
        self.assertEqual(receipt["outcome"], "partial")
        self.assertTrue(receipt["quality"]["truncated"])

    def test_query_bounds_and_malformed_markers_cannot_certify_complete_results(self):
        for tool, complete in (("get_query_results", "FINISHED"), ("get_logs_insight_query_results", "Complete")):
            for changes in ({"status": None}, {"status": []}, {"count": True}, {"count": 1},
                            {"results": {}}, {"nextToken": 1}):
                with self.subTest(tool=tool, changes=changes):
                    receipt = self.receipt(tool, {"status": complete, "results": [], "count": 0, **changes})
                    self.assertNotIn(receipt["outcome"], ("empty", "success"))
            # Both existing Lambda producers slice at 50 without emitting whether that slice dropped rows.
            receipt = self.receipt(tool, {
                "status": complete, "results": [{"message": "PRIVATE"}] * 50, "count": 50,
            })
            self.assertEqual(receipt["outcome"], "partial")
            self.assertTrue(receipt["quality"]["unknown"])

    def test_query_and_topology_envelopes_cannot_certify_empty_when_missing(self):
        from tool_receipts import terminal
        for tool in ("get_query_results", "get_logs_insight_query_results", "get_query_status",
                     "execute_log_insights_query", "lake_query"):
            for content in ([], [{"json": []}], [{"json": {}}]):
                self.assertEqual(terminal({"status": "success", "content": content}, tool=tool)[0], "unverified")
        for body in ({}, []):
            self.assertEqual(self.receipt("get_topology", body)["outcome"], "unverified")

    def test_metric_and_trace_empty_collections_remain_distinct(self):
        for tool, field in (("prometheus_query", "result"), ("mimir_query_range", "result"),
                            ("tempo_search", "traces")):
            self.assertEqual(self.receipt(tool, {field: [], "truncated": False})["outcome"], "empty")
            self.assertEqual(self.receipt(tool, {field: [], "truncated": True})["outcome"], "partial")

    def test_legacy_trusted_advisor_at_the_check_cap_has_unknown_remaining_coverage(self):
        receipt = self.receipt("get_trusted_advisor_cost_checks", {
            "checks": [{"status": "ok"}] * 15, "totalChecks": 15,
        })
        self.assertEqual(receipt["outcome"], "partial")
        self.assertTrue(receipt["quality"]["unknown"])


class BoundedProducerReceiptTest(unittest.TestCase):
    receipt = ProducerReceiptTest.receipt
    CRDS = ("virtualservices", "destinationrules", "gateways", "serviceentries",
            "authorizationpolicies", "peerauthentications")

    def test_trusted_advisor_errors_are_not_negative_health_findings(self):
        for checks, expected in [
            ([{"name": "PRIVATE", "error": "PRIVATE"}], "error"),
            ([{"status": "error", "flaggedResources": ["PRIVATE"]}], "success"),
            ([{"status": "warning"}, {"error": "PRIVATE"}], "partial"),
            ([], "empty"), ([{"error": "PRIVATE"}] * 16, "partial"),
        ]:
            with self.subTest(expected=expected, count=len(checks)):
                r = self.receipt("get_trusted_advisor_cost_checks", {
                    "checks": checks, "totalChecks": len(checks), "totalEstimatedMonthlySavings": 0,
                })
                self.assertEqual(r["outcome"], expected)
                if len(checks) > 15:
                    self.assertTrue(r["quality"]["truncated"])
        for checks in (None, [{}], [{"error": None}], [{"error": {}}], [{"status": []}], [{"status": ""}]):
            r = self.receipt("get_trusted_advisor_cost_checks", {"checks": checks})
            self.assertNotIn(r["outcome"], ("success", "empty"))
            self.assertTrue(r["quality"].get("invalid"))
        r = self.receipt("get_trusted_advisor_cost_checks", {"checks": [{"error": "PRIVATE"}], "truncated": True})
        self.assertEqual(r["outcome"], "partial")

    def test_opensearch_typed_collection_and_legacy_absence(self):
        failed = {"name": "PRIVATE", "collectionStatus": "error", "indices": []}
        empty = {"name": "PRIVATE", "collectionStatus": "empty", "indices": [], "truncated": False}
        populated = {"name": "PRIVATE", "collectionStatus": "ok", "indices": ["PRIVATE"], "truncated": False}
        for domains, top, expected in [
            ([failed], "ok", "error"), ([failed, empty], "ok", "partial"),
            ([empty], "ok", "empty"), ([populated], "ok", "success"),
            ([], "empty", "empty"), ([{**populated, "truncated": True}], "ok", "partial"),
            ([failed] * 21, "ok", "partial"),
        ]:
            with self.subTest(expected=expected, size=len(domains)):
                r = self.receipt("opensearch_schema", {"domains": domains, "collectionStatus": top})
                self.assertEqual(r["outcome"], expected)
                if len(domains) > 20:
                    self.assertTrue(r["quality"]["truncated"])
        for body in (
            {"domains": []}, {"domains": [{"indices": []}]},
            {"domains": [{"indices": ["PRIVATE"]}]},
            {"domains": [empty], "collectionStatus": None},
            {"domains": [{**empty, "collectionStatus": "ok"}], "collectionStatus": "ok"},
            {"domains": [{**populated, "truncated": "false"}], "collectionStatus": "ok"},
            {"domains": [{**populated, "collectionStatus": []}], "collectionStatus": "ok"},
        ):
            self.assertNotIn(self.receipt("opensearch_schema", body)["outcome"], ("success", "empty"))

    def test_opensearch_domain_metadata_errors_and_successful_empty(self):
        for domains, status, expected in [
            ([], "empty", "empty"),
            ([{"collectionStatus": "ok", "status": "RED", "endpoint": "PRIVATE"}], "ok", "success"),
            ([{"collectionStatus": "error"}], "ok", "error"),
            ([{"collectionStatus": "error"}, {"collectionStatus": "ok"}], "ok", "partial"),
            ([{"error": "PRIVATE"}] * 21, "ok", "partial"),
        ]:
            with self.subTest(expected=expected):
                self.assertEqual(self.receipt("list_opensearch_domains", {
                    "domains": domains, "collectionStatus": status,
                })["outcome"], expected)
        self.assertNotIn(self.receipt("list_opensearch_domains", {"domains": []})["outcome"], ("success", "empty"))

    def test_istio_namespace_collection_is_separate_from_crd_counts(self):
        zeros = dict.fromkeys(self.CRDS, 0)
        for counts, ns, status, expected in [
            (zeros, [], "empty", "empty"), (zeros, ["PRIVATE"], "ok", "success"),
            (zeros, [], "error", "partial"),
            ({**zeros, "virtualservices": None}, [], "empty", "partial"),
            (dict.fromkeys(self.CRDS, None), [], "error", "error"),
            ({**zeros, "virtualservices": 1}, [], "empty", "success"),
        ]:
            with self.subTest(status=status, expected=expected):
                self.assertEqual(self.receipt("mesh_overview", {
                    "counts": counts, "injected_namespaces": ns, "namespaceCollectionStatus": status,
                })["outcome"], expected)
        for changes in [
            {}, {"namespaceCollectionStatus": None}, {"namespaceCollectionStatus": []},
            {"namespaceCollectionStatus": "ok"}, {"namespaceCollectionStatus": "empty", "counts": {}},
            {"namespaceCollectionStatus": "empty", "counts": {**zeros, "gateways": True}},
            {"namespaceCollectionStatus": "empty", "counts": {**zeros, "future": "PRIVATE"}},
        ]:
            r = self.receipt("mesh_overview", {"counts": zeros, "injected_namespaces": [], **changes})
            self.assertNotIn(r["outcome"], ("success", "empty"))

    def test_nested_validation_error_and_local_findings_have_distinct_meanings(self):
        for validation, expected in [
            ({"valid": False, "error": "PRIVATE"}, "partial"), ({"valid": True}, "success"),
            (None, "unverified"), ({"valid": "false"}, "unverified"), ({"valid": False}, "unverified"),
        ]:
            for issues in ([], [{"severity": "HIGH", "message": "PRIVATE"}]):
                with self.subTest(validation=validation, expected=expected):
                    self.assertEqual(self.receipt("check_cloudformation_template_compliance", {
                        "validation": validation, "compliance_issues": issues,
                    })["outcome"], expected)

    def test_network_pagination_is_not_resource_state(self):
        for field in ("SecurityGroups", "NetworkAcls", "RouteTables", "Subnets", "Vpcs"):
            for token, expected in [("PRIVATE", "partial"), (None, "empty"), ("", "empty"), (True, "partial")]:
                r = self.receipt("describe_network", {field: [], "NextToken": token})
                self.assertEqual(r["outcome"], expected)
                self.assertTrue(r["quality"].get("truncated") if isinstance(token, str) and token else
                                r["quality"].get("invalid") if token is True else True)
        self.assertEqual(self.receipt("describe_network", {"Vpcs": [{"State": "pending"}]})["outcome"], "success")

    def test_specific_returned_counts_not_dynamodb_scanned_count(self):
        for tool, field, total in [
            ("search_opensearch_logs", "hits", "total"), ("get_dimension_values", "values", "count"),
            ("list_tables", "tables", "count"), ("query_table", "items", "count"),
        ]:
            for length, n, expected in [(0, 0, "empty"), (1, 1, "success"), (0, 3, "partial"),
                                        (1, 3, "partial"), (1, 0, "unverified"), (0, None, "unverified"),
                                        (0, True, "unverified")]:
                with self.subTest(tool=tool, returned=length, total=n):
                    r = self.receipt(tool, {field: ["PRIVATE"] * length, total: n, "truncated": False})
                    self.assertEqual(r["outcome"], expected)
                    if expected == "partial":
                        self.assertTrue(r["quality"]["truncated"])
        self.assertEqual(self.receipt("query_table", {"items": [], "count": 0, "scannedCount": 123, "truncated": False})["outcome"], "empty")

    def test_get_item_and_loki_empty_and_malformed_envelopes(self):
        for body, expected in [
            ({"item": None, "found": False}, "empty"), ({"item": {"id": "PRIVATE"}, "found": True}, "success"),
            ({"item": None, "found": True}, "unverified"), ({"item": {}, "found": False}, "unverified"),
            ({"item": None, "found": "false"}, "unverified"),
        ]:
            self.assertEqual(self.receipt("get_item", body)["outcome"], expected)
        for tool in ("loki_query", "loki_query_range"):
            self.assertEqual(self.receipt(tool, {"result": [], "truncated": False})["outcome"], "empty")
            self.assertEqual(self.receipt(tool, {"result": [], "truncated": True})["outcome"], "partial")
            self.assertEqual(self.receipt(tool, {"result": None})["outcome"], "unverified")

    def test_child_scans_stop_at_caps_without_reading_raw_payloads(self):
        from tool_receipts import terminal
        class Unreadable(dict):
            def get(self, *args):
                raise AssertionError("unbounded child read")
        class Unwalkable(list):
            def __iter__(self):
                raise AssertionError("raw result traversal")
        for tool, body in [
            ("get_trusted_advisor_cost_checks", {"checks": [{"error": "PRIVATE"}] * 15 + [Unreadable()]}),
            ("opensearch_schema", {"collectionStatus": "ok", "domains": [
                {"collectionStatus": "error"}] * 20 + [Unreadable()]}),
            ("mesh_overview", {"counts": dict.fromkeys(self.CRDS, 0), "namespaceCollectionStatus": "ok",
                               "injected_namespaces": Unwalkable(["PRIVATE"])}),
            ("query_table", {"items": Unwalkable(["PRIVATE"]), "count": 1, "scannedCount": 3, "truncated": False}),
        ]:
            outcome, q, _ = terminal({"status": "success", "content": [{"json": body}]}, tool=tool)
            self.assertIn(outcome, ("success", "partial"))
            self.assertNotIn("PRIVATE", json.dumps(q))

    def test_list_pagination_requires_producer_evidence_and_preserves_empty(self):
        for tool, field in [("list_users", "users"), ("list_roles", "roles"), ("list_groups", "groups"),
                            ("list_policies", "policies"), ("list_tables", "tables"),
                            ("query_table", "items"), ("scan_table", "items")]:
            for marker, expected in [({"truncated": False}, "empty"), ({"truncated": True}, "partial"),
                                     ({"truncated": False, "unknown": True}, "partial"),
                                     ({"truncated": "false"}, "partial"), ({}, "partial")]:
                with self.subTest(tool=tool, marker=marker):
                    self.assertEqual(self.receipt(tool, {field: [], "count": 0, **marker})["outcome"], expected)
