"""AWSops v2 — AI Diagnosis native source collectors (read-only, PII-minimizing).
Each collect_* returns {"key","ok","degraded","notes","data"} and NEVER raises:
a failure degrades gracefully so a report still renders with a 'data unavailable' note.
Sources: Aurora inventory, CloudWatch metrics, Cost Explorer, Security Hub/Config posture,
X-Ray service map (actual traffic flow), CloudTrail what-changed. NO raw log lines.
"""
import os
import boto3
from botocore.exceptions import ClientError

import db as wdb  # noqa: F401 — worker db (parent dir, flat /app layout); reserved for future DB seams

REGION = os.environ.get("AWS_REGION", "ap-northeast-2")

_THROTTLE_CODES = (
    "Throttling", "ThrottlingException", "TooManyRequestsException", "RequestLimitExceeded",
)


def _result(key, ok=True, data=None, degraded=False, notes=""):
    return {"key": key, "ok": ok, "degraded": degraded, "notes": notes, "data": data or {}}


def _classify(key, exc):
    """Distinguish a throttled/failed call (loud) from an unconfigured service (quiet).
    A throttle or any ClientError marks data with `_failed` so the report status becomes
    'partial' and a loud failure line surfaces — never a false all-clear."""
    code = ""
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
    if code in _THROTTLE_CODES:
        return _result(key, ok=False, degraded=True, notes=f"THROTTLED: {code}", data={"_failed": True})
    if code:
        return _result(key, ok=False, degraded=True, notes=f"FAILED: {code}", data={"_failed": True})
    return _result(key, ok=False, degraded=True, notes=str(exc), data={"_failed": True})


# Wrapped so tests can monkeypatch a single seam per service.
def _ce_client():
    return boto3.client("ce", region_name=REGION)


def _cw_client():
    return boto3.client("cloudwatch", region_name=REGION)


def _xray_client():
    return boto3.client("xray", region_name=REGION)


def _ct_client():
    return boto3.client("cloudtrail", region_name=REGION)


def _sh_client():
    return boto3.client("securityhub", region_name=REGION)


def collect_inventory(conn):
    """Aurora inventory_resources counts by type (already synced; no live AWS call)."""
    try:
        rows = conn.run(
            "SELECT resource_type, count(*) FROM inventory_resources GROUP BY resource_type ORDER BY 2 DESC"
        )
        return _result("inventory", data={"by_type": {r[0]: int(r[1]) for r in rows}})
    except Exception as e:  # noqa: BLE001 — degrade, never raise
        return _classify("inventory", e)


def collect_cw_metrics(conn):
    """CloudWatch AWS/EC2 CPUUtilization (avg) per instance, ids pulled from inventory_resources.
    No raw log lines — aggregated metric statistics only. Degrades gracefully."""
    try:
        import datetime as dt
        # Instance ids from the already-synced inventory (no live describe needed).
        try:
            rows = conn.run(
                "SELECT resource_id FROM inventory_resources "
                "WHERE resource_type IN ('ec2_instance','aws_ec2_instance','instance') LIMIT 50"
            )
            instance_ids = [r[0] for r in rows if r and r[0]]
        except Exception:  # noqa: BLE001 — inventory shape varies; tolerate
            instance_ids = []
        if not instance_ids:
            return _result("cw_metrics", data={"by_instance": {}, "avg_cpu": None},
                           notes="no ec2 instance ids in inventory")
        cw = _cw_client()
        end = dt.datetime.utcnow()
        start = end - dt.timedelta(hours=3)
        queries = [
            {
                "Id": f"cpu{i}",
                "MetricStat": {
                    "Metric": {
                        "Namespace": "AWS/EC2",
                        "MetricName": "CPUUtilization",
                        "Dimensions": [{"Name": "InstanceId", "Value": iid}],
                    },
                    "Period": 3600,
                    "Stat": "Average",
                },
                "ReturnData": True,
            }
            for i, iid in enumerate(instance_ids)
        ]
        r = cw.get_metric_data(MetricDataQueries=queries, StartTime=start, EndTime=end)
        by_instance = {}
        for i, iid in enumerate(instance_ids):
            for mr in r.get("MetricDataResults", []):
                if mr.get("Id") == f"cpu{i}":
                    vals = mr.get("Values", [])
                    by_instance[iid] = round(sum(vals) / len(vals), 2) if vals else None
        nums = [v for v in by_instance.values() if v is not None]
        avg_cpu = round(sum(nums) / len(nums), 2) if nums else None
        return _result("cw_metrics", data={"by_instance": by_instance, "avg_cpu": avg_cpu})
    except Exception as e:  # noqa: BLE001
        return _classify("cw_metrics", e)


def collect_cost():
    """Cost Explorer MTD by service (aggregated $; no PII). Read-only GetCostAndUsage."""
    try:
        ce = _ce_client()
        import datetime as dt
        today = dt.date.today()
        start = today.replace(day=1).isoformat()
        end = (today + dt.timedelta(days=1)).isoformat()
        r = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end}, Granularity="MONTHLY",
            Metrics=["UnblendedCost"], GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        groups = r.get("ResultsByTime", [{}])[0].get("Groups", [])
        by_service = {g["Keys"][0]: float(g["Metrics"]["UnblendedCost"]["Amount"]) for g in groups}
        return _result("cost", data={"mtd_by_service": by_service})
    except Exception as e:  # noqa: BLE001
        return _classify("cost", e)


def collect_service_map():
    """X-Ray service graph = actual traffic flow (topology + RED metrics). No log payloads."""
    try:
        import datetime as dt
        xr = _xray_client()
        end = dt.datetime.utcnow()
        start = end - dt.timedelta(hours=3)
        g = xr.get_service_graph(StartTime=start, EndTime=end)
        edges = []
        for svc in g.get("Services", []):
            name = svc.get("Name")
            for e in svc.get("Edges", []):
                s = e.get("SummaryStatistics", {})
                edges.append({
                    "from": name, "to_ref": e.get("ReferenceId"),
                    "calls": s.get("TotalCount", 0),
                    "error_rate": round((s.get("ErrorStatistics", {}).get("TotalCount", 0)
                                         / s["TotalCount"]) if s.get("TotalCount") else 0, 4),
                })
        return _result("service_map", data={"edges": edges, "service_count": len(g.get("Services", []))})
    except Exception as e:  # noqa: BLE001
        return _classify("service_map", e)


def collect_posture():
    """Security Hub active findings rollup by severity (CIS/best-practice). No PII."""
    try:
        sh = _sh_client()
        r = sh.get_findings(
            Filters={"RecordState": [{"Value": "ACTIVE", "Comparison": "EQUALS"}],
                     "WorkflowStatus": [{"Value": "NEW", "Comparison": "EQUALS"}]},
            MaxResults=100,
        )
        by_sev = {}
        for f in r.get("Findings", []):
            sev = f.get("Severity", {}).get("Label", "UNKNOWN")
            by_sev[sev] = by_sev.get(sev, 0) + 1
        return _result("posture", data={"findings_by_severity": by_sev})
    except Exception as e:  # noqa: BLE001
        return _classify("posture", e)


def collect_what_changed():
    """CloudTrail management-event change summary (last 24h). PII-stripped: each event is mapped
    to {name, source, time} ONLY — Username/identity, Resources, and request params are dropped
    at the collector so they never reach the report context."""
    try:
        import datetime as dt
        ct = _ct_client()
        end = dt.datetime.utcnow()
        start = end - dt.timedelta(hours=24)
        r = ct.lookup_events(
            LookupAttributes=[{"AttributeKey": "ReadOnly", "AttributeValue": "false"}],
            StartTime=start, EndTime=end, MaxResults=50,
        )
        events = [{"name": e.get("EventName"), "source": e.get("EventSource"),
                   "time": e.get("EventTime").isoformat() if e.get("EventTime") else None}
                  for e in r.get("Events", [])]
        return _result("what_changed", data={"recent_changes": events})
    except Exception as e:  # noqa: BLE001
        return _classify("what_changed", e)


# Ordered registry of native collectors. `conn` is passed only to DB-backed ones.
def collect_all(conn):
    return [
        collect_inventory(conn),
        collect_cw_metrics(conn),
        collect_cost(),
        collect_service_map(),
        collect_posture(),
        collect_what_changed(),
    ]
