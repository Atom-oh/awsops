"""Semantic evidence boundaries, using current producer envelopes and the public stream adapter."""
import copy
import json
from pathlib import Path
import unittest

import test_tool_receipts as helpers
from test_tool_receipts import collect, known_use, result, metric_body
from tool_receipts import terminal


def topology_body():
    return {
        "class": "trace", "nodes": [{"id": "service-a", "kind": "service", "label": "A", "meta": {}}],
        "edges": [], "node_count": 1, "edge_count": 0, "selection": {"status": "all"},
        "truncation": {"nodes": False, "edges": False, "node_limit": 500, "edge_limit": 1000},
        "collection": {"status": "ok", "stale": False, "captured_at": "2026-09-14T00:00:00Z",
                       "sources": [{"sourceId": "clickhouse:7", "status": "ok", "itemCount": 1}]},
    }


class EvidenceBoundaryTest(unittest.TestCase):
    receipt = helpers.ProducerReceiptTest.receipt

    def test_erasing_producer_contract_requires_current_source_markers(self):
        for tool, body in [
            ("search_opensearch_logs", {"hits": [], "count": 0, "total": 0}),
            ("prometheus_labels", {"labels": [], "truncated": False}),
            ("mimir_series", {"series": [], "truncated": False}),
            ("loki_label_values", {"values": [], "truncated": False}),
            ("tempo_search", {"traces": [], "truncated": False}),
            ("notion_search", {"results": [], "has_more": False}),
            ("notion_fetch_page", {"page": {"object": "page", "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
                                   "blocks": [], "truncated": False}),
        ]:
            with self.subTest(tool=tool):
                self.assertEqual(self.receipt(tool, body)["outcome"], "unverified")

    def test_loki_requires_source_status_shape_and_observed_completeness(self):
        row = {"stream": {"job": "PRIVATE"}, "values": [["1700000000000000000", "PRIVATE log"]]}
        for tool in ("loki_query", "loki_query_range"):
            for body, expected in [
                ({"resultType": "streams", "result": [], "truncated": False}, "unverified"),
                ({"resultType": "streams", "result": [row], "truncated": False}, "unverified"),
                ({"resultType": None, "result": [], "truncated": False, "collectionStatus": "empty"}, "unverified"),
                ({"resultType": "streams", "result": [], "truncated": False, "collectionStatus": "empty"}, "empty"),
                ({"resultType": "streams", "result": [row], "truncated": False, "collectionStatus": "ok"}, "success"),
                ({"resultType": "streams", "result": [row], "truncated": False, "collectionStatus": "partial"}, "partial"),
                ({"resultType": "streams", "result": [row], "truncated": False, "collectionStatus": "unknown"}, "unverified"),
                ({"resultType": "streams", "result": [{}], "truncated": False, "collectionStatus": "ok"}, "unverified"),
                ({"resultType": "streams", "result": [{**row, "values": [[True, "line"]]}], "truncated": False, "collectionStatus": "ok"}, "unverified"),
                ({"resultType": "streams", "result": [], "truncated": False, "collectionStatus": "ok"}, "unverified"),
                ({"resultType": "vector", "result": [{"metric": {}, "value": [1, "2"]}], "truncated": False, "collectionStatus": "ok"}, "success"),
                ({"resultType": "matrix", "result": [{"metric": {}, "values": [[1, "2"]]}], "truncated": False, "collectionStatus": "ok"}, "success"),
            ]:
                with self.subTest(tool=tool, body=body):
                    receipt = self.receipt(tool, body)
                    self.assertEqual(receipt["outcome"], expected)
                    self.assertNotIn("PRIVATE", json.dumps(receipt))

    def test_cost_dimension_values_without_continuation_evidence_are_partial(self):
        # The real producer returns page-local count and discards NextPageToken.
        for rows in ([], ["PRIVATE service"]):
            receipt = self.receipt("get_dimension_values", {"dimension": "SERVICE", "values": rows, "count": len(rows)})
            self.assertEqual(receipt["outcome"], "partial")
            self.assertTrue(receipt["quality"]["unknown"])

    def test_known_failures_survive_unverified_content_and_child_results(self):
        for blocks in ([{"json": {"error": "PRIVATE"}}, {"json": {}}],
                       [{"json": {}}, {"json": {"error": "PRIVATE"}}]):
            outcome, quality, _ = terminal({"status": "success", "content": blocks}, tool="future_producer")
            self.assertEqual(outcome, "partial")
            self.assertNotIn("PRIVATE", json.dumps(quality))
        self.assertEqual(self.receipt("get_trusted_advisor_cost_checks", {
            "checks": [{"error": "PRIVATE"}, {"status": "not_available"}],
        })["outcome"], "partial")

    def test_metric_queries_require_upstream_collection_markers(self):
        for tool in ("prometheus_query", "prometheus_query_range", "mimir_query", "mimir_query_range"):
            for rows in ([], [{"metric": {}, "value": [1, "1"]}]):
                body = {"resultType": "vector", "result": rows, "truncated": False}
                self.assertEqual(self.receipt(tool, body)["outcome"], "unverified")
                self.assertEqual(self.receipt(tool, {**body, "collectionStatus": "partial"})["outcome"], "partial")
                self.assertEqual(self.receipt(tool, {**body, "collectionStatus": "unknown"})["outcome"], "unverified")

    def test_inventory_field_limited_types_do_not_certify_full_evidence(self):
        for resource_type in ("ecs", "ec2", "future_type"):
            for n in (0, 1):
                body = {"resource_type": resource_type, "resources": [{}] * n, "count": n,
                        "freshness": helpers.inventory_row(count=n, resource_type=resource_type),
                        "note": "field-level detail is limited by the sql_reader view security boundary"}
                with self.subTest(resource_type=resource_type, count=n):
                    receipt = self.receipt("query_inventory", body)
                    self.assertEqual(receipt["outcome"], "partial")
                    self.assertTrue(receipt["quality"]["unknown"])
                    self.assertEqual(receipt["quality"]["collection"]["status"], "partial")
                    self.assertNotIn("security boundary", json.dumps(receipt))

    def test_unknown_or_forged_source_status_cannot_certify_positive_data(self):
        for status in (None, {}, "future", "unknown"):
            self.assertEqual(self.receipt("prometheus_labels", {
                "labels": [], "truncated": False, "collectionStatus": status,
            })["outcome"], "unverified")
        self.assertEqual(self.receipt("prometheus_labels", {
            "labels": ["job"], "truncated": False, "collectionStatus": "empty",
        })["outcome"], "unverified")
        self.assertEqual(self.receipt("search_opensearch_logs", {
            "hits": [], "count": 0, "total": 0, "collectionStatus": "empty",
        })["outcome"], "unverified")

    def test_unknown_json_or_empty_content_never_certifies_completion(self):
        for body in ({}, [], [{"id": "PRIVATE"}], {"id": "PRIVATE"}, {"results": []},
                     {"partial": False, "unknown": [], "truncated": False},
                     topology_body(), metric_body()):
            with self.subTest(body=body):
                self.assertEqual(self.receipt("future_producer", body)["outcome"], "unverified")
        self.assertEqual(terminal({"status": "success", "content": []}, tool="future_producer")[0], "unverified")

    def test_errors_and_negative_quality_remain_restrictive_for_unknown_shapes(self):
        for body, expected in [({"error": "PRIVATE"}, "error"), ({"isError": True}, "error"),
                               ({"partial": True}, "partial"), ({"truncated": True}, "partial"),
                               ({"collection": {"status": "unavailable"}}, "partial")]:
            self.assertEqual(self.receipt("future_producer", body)["outcome"], expected)
        self.assertEqual(terminal({"status": "error", "content": []})[0], "error")

    def test_topology_requires_payload_selection_and_collection_together(self):
        body = topology_body()
        self.assertEqual(self.receipt("get_topology", body)["outcome"], "success")
        empty = {**body, "nodes": [], "node_count": 0, "collection": {
            **body["collection"], "status": "empty", "sources": [
                {"sourceId": "clickhouse:7", "status": "empty", "itemCount": 0}],
        }}
        self.assertEqual(self.receipt("get_topology", empty)["outcome"], "empty")
        for key in ("class", "nodes", "edges", "node_count", "edge_count", "selection", "truncation", "collection"):
            broken = copy.deepcopy(body)
            del broken[key]
            with self.subTest(missing=key):
                self.assertNotIn(self.receipt("get_topology", broken)["outcome"], ("success", "empty"))
        for change in ({"nodes": []}, {"node_count": True}, {"edges": [{"source": "missing", "target": "service-a"}]},
                       {"collection": {"status": "ok"}}, {"selection": {"status": "resolved"}}):
            self.assertNotIn(self.receipt("get_topology", {**body, **change})["outcome"], ("success", "empty"))

    def test_eni_known_name_or_quality_alone_is_not_a_complete_configuration(self):
        for body in ({}, {"eniId": "eni-fixture"}, {"partial": False, "unknown": []},
                     {"collection": {"status": "ok"}}, {"enis": [], "count": 0}):
            self.assertNotIn(self.receipt("get_eni_details", body)["outcome"], ("success", "empty"))
        eni = {"eniId": "eni-fixture", "privateIp": "192.0.2.1", "vpcId": "vpc-fixture", "subnetId": "subnet-fixture"}
        body = {"ip": "192.0.2.1", "enis": [eni], "count": 1}
        self.assertEqual(self.receipt("find_ip_address", body)["outcome"], "success")
        for change in ({"ip": ""}, {"count": 0}, {"enis": [{}]}, {"enis": []}):
            self.assertNotIn(self.receipt("find_ip_address", {**body, **change})["outcome"], ("success", "empty"))
        capped = {**body, "enis": [eni] * 10, "count": 10}
        self.assertEqual(self.receipt("find_ip_address", capped)["outcome"], "partial")
        # The current Lambda only searches private/public IPv4 filters.
        self.assertEqual(self.receipt("find_ip_address", {
            "ip": "2001:db8::1", "enis": [], "count": 0,
        })["outcome"], "unverified")

    def test_notion_distinguishes_page_metadata_from_empty_search(self):
        page = {"object": "page", "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}
        for tool in ("notion_search", "notion_query_database"):
            for rows, expected in [([], "empty"), ([page], "success")]:
                self.assertEqual(self.receipt(tool, {"results": rows, "has_more": False, "next_cursor": None,
                                                    "collectionStatus": "ok" if rows else "empty"})["outcome"], expected)
            for body in ({"results": []}, {"results": [], "has_more": "false"},
                         {"results": [{}], "has_more": False}, {"results": None, "has_more": False}):
                self.assertNotIn(self.receipt(tool, body)["outcome"], ("success", "empty"))
        self.assertEqual(self.receipt("notion_fetch_page", {"page": page, "blocks": [], "truncated": False,
                                                          "collectionStatus": "ok", "blocksCollectionStatus": "empty"})["outcome"], "success")
        self.assertEqual(self.receipt("notion_fetch_page", {"page": page, "blocks": [], "truncated": False,
                                                          "blocks_error": "PRIVATE"})["outcome"], "partial")
        self.assertNotIn(self.receipt("notion_fetch_page", {"page": {}, "blocks": [], "truncated": False})["outcome"], ("success", "empty"))

    def test_prometheus_mimir_and_tempo_need_real_envelopes(self):
        for tool in ("prometheus_query", "prometheus_query_range", "mimir_query", "mimir_query_range"):
            self.assertEqual(self.receipt(tool, metric_body())["outcome"], "success")
            matrix = {"resultType": "matrix", "result": [{"metric": {}, "values": [[1, "0"]]}], "truncated": False, "collectionStatus": "ok"}
            self.assertEqual(self.receipt(tool, matrix)["outcome"], "success")
            for body in ({}, {"result": []}, {"resultType": "future", "result": [], "truncated": False},
                         {"resultType": "vector", "result": [{}], "truncated": False}):
                self.assertNotIn(self.receipt(tool, body)["outcome"], ("success", "empty"))
        self.assertEqual(self.receipt("tempo_search", {"traces": [{"traceID": "a1B2c3"}], "truncated": False,
                                                      "collectionStatus": "ok"})["outcome"], "success")
        self.assertEqual(self.receipt("tempo_search", {"traces": [], "truncated": False, "collectionStatus": "empty"})["outcome"], "empty")
        self.assertNotIn(self.receipt("tempo_search", {"traces": [{}], "truncated": False})["outcome"], ("success", "empty"))
        self.assertEqual(self.receipt("tempo_get_trace", {"batches": [], "truncated": False})["outcome"], "empty")
        self.assertNotIn(self.receipt("tempo_get_trace", {"truncated": False})["outcome"], ("success", "empty"))
        for groups in ("scopeSpans", "instrumentationLibrarySpans"):
            self.assertEqual(self.receipt("tempo_get_trace", {"batches": [{
                groups: [{"spans": [{"traceId": "a1", "spanId": "b2", "attributes": "PRIVATE"}]}],
            }], "truncated": False})["outcome"], "success")

    def test_positive_handlers_stop_before_overflow_and_do_not_accept_false_scalar_metadata(self):
        class Unreadable(dict):
            def get(self, *args):
                raise AssertionError("overflow tail must not be inspected")
        for tool, body in [
            ("prometheus_query", {**metric_body(), "result": [Unreadable()] * 51}),
            ("tempo_search", {"traces": [Unreadable()] * 51, "truncated": False, "collectionStatus": "ok"}),
            ("get_topology", {**topology_body(), "nodes": [Unreadable()] * 501, "node_count": 501}),
        ]:
            outcome, q, _ = terminal({"status": "success", "content": [{"json": body}]}, tool=tool)
            self.assertEqual(outcome, "partial")
            self.assertTrue(q["truncated"])
        for tool in ("prometheus_query", "notion_fetch_page", "get_eni_details", "get_topology", "tempo_get_trace"):
            for value in ([], {}, {"partial": False, "truncated": False}):
                self.assertEqual(self.receipt(tool, value)["outcome"], "unverified")

    def test_named_metric_lists_require_their_declared_envelope(self):
        for tool, field, row in [
            ("prometheus_labels", "labels", "job"), ("mimir_labels", "labels", "job"),
            ("prometheus_series", "series", {"job": "fixture"}), ("mimir_series", "series", {"job": "fixture"}),
            ("loki_labels", "labels", "job"), ("loki_label_values", "values", "fixture"),
        ]:
            for values, expected in [([], "empty"), ([row], "success")]:
                self.assertEqual(self.receipt(tool, {field: values, "truncated": False,
                                                    "collectionStatus": "ok" if values else "empty"})["outcome"], expected)
            self.assertEqual(self.receipt(tool, {field: []})["outcome"], "unverified")

    def test_unknown_and_mixed_reader_cases_preserve_text_and_completion(self):
        cases = json.loads((Path(__file__).parent / "fixtures/receipt-reader-cases.json").read_text())
        for case in cases:
            events = []
            for i, call in enumerate(case["calls"]):
                events += [known_use(f"call-{i}", call["tool"]), result(f"call-{i}", call["body"])]
            frames = collect([*events, {"data": case["text"]}])
            self.assertEqual("".join(f.get("delta", "") for f in frames), case["text"])
            self.assertEqual([f["receipt"]["outcome"] for f in frames if "receipt" in f], case["outcomes"])
            self.assertEqual(frames[-1], {"completion": {"version": 1, "receiptCount": len(case["calls"])}})
