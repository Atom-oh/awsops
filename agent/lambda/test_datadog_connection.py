"""Offline connection-probe regressions; no credentials or external calls."""
import json
import unittest
from unittest import mock

import datadog_mcp as dd


class DatadogConnectionTest(unittest.TestCase):
    def probe(self, responses):
        creds = {
            "endpoint": "https://api.datadoghq.com", "authType": "custom_header",
            "headerName": "DD-API-KEY", "headerValue": "synthetic-api",
            "headerName2": "DD-APPLICATION-KEY", "headerValue2": "synthetic-app",
        }
        with mock.patch.object(dd, "load_datasource", return_value=creds), \
                mock.patch.object(dd, "assert_host_allowed"), \
                mock.patch.object(dd, "http_json", side_effect=responses) as http:
            result = json.loads(dd.datadog_health({})["body"])
        return result, http

    def test_api_key_alone_does_not_establish_query_access(self):
        result, http = self.probe([(200, {"valid": True}), (403, {"errors": ["invalid application key"]})])
        self.assertFalse(result["ok"])
        self.assertEqual(http.call_count, 2)

    def test_checks_query_permission_and_accepts_an_empty_metric_result(self):
        result, http = self.probe([(200, {"valid": True}), (200, {"status": "ok", "series": []})])
        self.assertTrue(result["ok"])
        self.assertEqual(http.call_count, 2)
        self.assertIn("/api/v1/query?", http.call_args_list[1].args[1])
        self.assertEqual(http.call_args_list[1].kwargs["headers"]["DD-APPLICATION-KEY"], "synthetic-app")

    def test_invalid_api_key_stops_before_metric_query(self):
        result, http = self.probe([(200, {"valid": False})])
        self.assertFalse(result["ok"])
        self.assertEqual(http.call_count, 1)


if __name__ == "__main__":
    unittest.main()
