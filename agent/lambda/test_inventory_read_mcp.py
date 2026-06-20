"""Tests for inventory_read_mcp — Aurora-backed read-only topology/unused-resource MCP tool.

The pure detection logic (detect_unused) takes already-fetched inventory rows (the JSONB `data`
of inventory_resources, keyed by resource_type) so it is testable with fixtures — no DB, no boto3.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import inventory_read_mcp as inv  # noqa: E402


def _tg(name, lb_arns, states):
    """A target_group `data` row: load_balancer_arns + target_health_descriptions[].TargetHealth.State."""
    return {
        "target_group_arn": f"arn:aws:elasticloadbalancing:ap-northeast-2:1:targetgroup/{name}/abc",
        "target_group_name": name,
        "load_balancer_arns": lb_arns,
        "target_health_descriptions": [{"Target": {"Id": f"i-{i}"}, "TargetHealth": {"State": s}}
                                       for i, s in enumerate(states)],
    }


def _lb(name, dns):
    return {"name": name, "dns_name": dns, "arn": f"arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/{name}/xyz",
            "type": "application", "state_code": "active"}


def _cf(cid, enabled, origin_domains):
    return {"id": cid, "domain_name": f"{cid}.cloudfront.net", "enabled": enabled,
            "origins": [{"DomainName": d, "Id": d} for d in origin_domains]}


class TestOrphanTargetGroup(unittest.TestCase):
    def test_tg_with_no_load_balancer_is_flagged_high(self):
        findings = inv.detect_unused({"target_group": [_tg("orphan-tg", [], [])]})
        hit = [f for f in findings if f["resource_id"].endswith("orphan-tg/abc") or f["name"] == "orphan-tg"]
        self.assertEqual(len(hit), 1, f"expected orphan-tg flagged once, got {findings}")
        self.assertEqual(hit[0]["severity"], "high")
        self.assertEqual(hit[0]["resource_type"], "TargetGroup")
        self.assertIn("load balancer", hit[0]["reason"].lower())

    def test_tg_attached_to_lb_is_not_orphan(self):
        findings = inv.detect_unused({
            "target_group": [_tg("attached-tg", ["arn:...:loadbalancer/app/x/1"], ["healthy"])],
        })
        self.assertEqual([f for f in findings if f["name"] == "attached-tg"], [])


class TestUnhealthyTargetGroup(unittest.TestCase):
    def test_attached_tg_with_zero_healthy_is_flagged(self):
        findings = inv.detect_unused({
            "target_group": [_tg("dead-tg", ["arn:...:loadbalancer/app/x/1"], ["unhealthy", "unhealthy"])],
        })
        hit = [f for f in findings if f["name"] == "dead-tg"]
        self.assertEqual(len(hit), 1)
        self.assertEqual(hit[0]["severity"], "high")
        self.assertIn("healthy", hit[0]["reason"].lower())

    def test_healthy_tg_not_flagged(self):
        findings = inv.detect_unused({
            "target_group": [_tg("live-tg", ["arn:...:loadbalancer/app/x/1"], ["healthy", "unhealthy"])],
        })
        self.assertEqual([f for f in findings if f["name"] == "live-tg"], [])


class TestEmptyCloudFrontOrigin(unittest.TestCase):
    def test_origin_pointing_at_lb_with_no_healthy_backend_is_empty(self):
        dns = "grafana-nlb.elb.ap-northeast-2.amazonaws.com"
        findings = inv.detect_unused({
            "cloudfront": [_cf("E1EMPTY", True, [dns])],
            "nlb": [_lb("grafana-nlb", dns)],
            # the only TG on this LB has zero healthy targets → origin is "empty"
            "target_group": [_tg("g-tg", ["arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/grafana-nlb/xyz"], [])],
        })
        hit = [f for f in findings if f["resource_type"] == "CloudFront" and "E1EMPTY" in f["resource_id"]]
        self.assertTrue(hit, f"expected empty-origin CF flagged, got {findings}")
        self.assertIn("origin", hit[0]["reason"].lower())

    def test_origin_with_healthy_backend_not_flagged_as_empty(self):
        dns = "good-alb.elb.ap-northeast-2.amazonaws.com"
        findings = inv.detect_unused({
            "cloudfront": [_cf("E1GOOD", True, [dns])],
            "alb": [_lb("good-alb", dns)],
            "target_group": [_tg("ok-tg", ["arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/good-alb/xyz"], ["healthy"])],
        })
        self.assertEqual([f for f in findings if f["resource_type"] == "CloudFront" and "E1GOOD" in f["resource_id"]], [])

    def test_disabled_distribution_flagged_medium(self):
        findings = inv.detect_unused({"cloudfront": [_cf("E1OFF", False, [])]})
        hit = [f for f in findings if "E1OFF" in f["resource_id"]]
        self.assertTrue(hit)
        self.assertEqual(hit[0]["severity"], "medium")


class TestUnattachedEbs(unittest.TestCase):
    def test_available_volume_flagged_high(self):
        findings = inv.detect_unused({"ebs": [{"volume_id": "vol-1", "state": "available", "size": 50, "volume_type": "gp3"}]})
        hit = [f for f in findings if f["resource_id"] == "vol-1"]
        self.assertEqual(len(hit), 1)
        self.assertEqual(hit[0]["severity"], "high")

    def test_in_use_volume_not_flagged(self):
        findings = inv.detect_unused({"ebs": [{"volume_id": "vol-2", "state": "in-use", "size": 50}]})
        self.assertEqual([f for f in findings if f["resource_id"] == "vol-2"], [])


class TestEmptyInputSafe(unittest.TestCase):
    def test_no_inventory_returns_empty_list(self):
        self.assertEqual(inv.detect_unused({}), [])


if __name__ == "__main__":
    unittest.main()
