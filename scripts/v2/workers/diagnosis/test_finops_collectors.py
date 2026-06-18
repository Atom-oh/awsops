"""WS-A2 — FinOps depth collectors (idle waste, RI/SP coverage, cost MoM + usage-type).
New file so it does not touch the concurrent data-branch's test_sources.py. No live AWS/DB."""
from diagnosis import sources


class FakeConn:
    def __init__(self, by_type):
        self.by_type = by_type  # {resource_type: [data_dict_or_json_str, ...]}

    def run(self, sql, **_kw):
        for t, rows in self.by_type.items():
            if f"resource_type='{t}'" in sql:
                return [[d] for d in rows]
        return []


def test_collect_idle_unattached_ebs_and_stopped_ec2():
    conn = FakeConn({
        "ebs_volume": [
            {"state": "available", "size": 100, "volume_type": "gp3"},   # unattached
            {"state": "in-use", "size": 50, "volume_type": "gp2"},       # attached → ignored
            '{"state": "available", "size": 10, "volume_type": "gp2"}',  # JSON-string form tolerated
        ],
        "ec2": [{"instance_state": "stopped"}, {"instance_state": "running"}],
    })
    r = sources.collect_idle(conn)
    assert r["ok"] is True
    ebs = r["data"]["unattached_ebs"]
    assert ebs["count"] == 2 and ebs["gb"] == 110.0
    assert ebs["est_monthly_usd"] == 10.26  # 100*0.0912 + 10*0.114
    assert r["data"]["stopped_ec2"]["count"] == 1


def test_collect_idle_degrades_on_db_error():
    class Boom:
        def run(self, *a, **k):
            raise RuntimeError("db down")
    r = sources.collect_idle(Boom())
    assert r["degraded"] is True  # never raises


class FakeCE:
    def __init__(self):
        self.calls = []

    def get_cost_and_usage(self, TimePeriod, Granularity, Metrics, GroupBy=None):  # noqa: N803
        key = GroupBy[0]["Key"] if GroupBy else None
        self.calls.append(key)
        if key == "SERVICE":
            return {"ResultsByTime": [{"Groups": [{"Keys": ["EC2"], "Metrics": {"UnblendedCost": {"Amount": "123.456"}}}]}]}
        if key == "USAGE_TYPE":
            return {"ResultsByTime": [{"Groups": [
                {"Keys": ["NatGateway-Bytes"], "Metrics": {"UnblendedCost": {"Amount": "40"}}},
                {"Keys": ["DataTransfer-Out"], "Metrics": {"UnblendedCost": {"Amount": "60"}}},
            ]}]}
        return {"ResultsByTime": [
            {"TimePeriod": {"Start": "2026-04-01"}, "Total": {"UnblendedCost": {"Amount": "100"}}},
            {"TimePeriod": {"Start": "2026-05-01"}, "Total": {"UnblendedCost": {"Amount": "200"}}},
        ]}

    def get_reservation_coverage(self, TimePeriod):  # noqa: N803
        return {"Total": {"CoverageHours": {"CoverageHoursPercentage": "55.5"}}}

    def get_savings_plans_coverage(self, TimePeriod):  # noqa: N803
        return {"SavingsPlansCoverages": [{"Coverage": {"CoveragePercentage": "30.0"}}]}


def test_collect_cost_adds_mom_trend_and_usage_types(monkeypatch):
    fake = FakeCE()
    monkeypatch.setattr(sources, "_ce_client", lambda: fake)
    d = sources.collect_cost()["data"]
    assert d["mtd_by_service"]["EC2"] == 123.46
    assert [m["total"] for m in d["monthly_totals"]] == [100.0, 200.0]
    assert d["top_usage_types"]["DataTransfer-Out"] == 60.0  # sorted desc
    assert {"SERVICE", "USAGE_TYPE", None} <= set(fake.calls)  # 3 distinct CE calls


def test_collect_commitment_coverage(monkeypatch):
    monkeypatch.setattr(sources, "_ce_client", lambda: FakeCE())
    d = sources.collect_commitment()["data"]
    assert d["ri_coverage_pct"] == 55.5 and d["sp_coverage_pct"] == 30.0


def test_collect_commitment_degrades_per_call(monkeypatch):
    class PartialCE(FakeCE):
        def get_reservation_coverage(self, TimePeriod):  # noqa: N803
            raise RuntimeError("AccessDenied")
    monkeypatch.setattr(sources, "_ce_client", lambda: PartialCE())
    d = sources.collect_commitment()["data"]
    assert d["ri_coverage_pct"] is None      # RI denied → None
    assert d["sp_coverage_pct"] == 30.0       # SP still resolves
