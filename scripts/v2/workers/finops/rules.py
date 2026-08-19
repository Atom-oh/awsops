"""ADR-019 active rule implementations. Each rule is `(conn, ce_calls) -> list[dict]`, where
ce_calls is a single-element list used as a mutable int counter (Cost Explorer calls are metered
into finops_runs.ce_api_calls — Compute Optimizer/inventory_resources calls are NOT CE calls and
don't increment it). Each item dict has:
  resource_id, title, category, monthly_savings_usd (float or None — NEVER 0 as a stand-in for
  "unknown"), evidence (dict, JSON-serializable), tags (dict or None), finding_reason (str or None,
  passed to guards.insufficient_observation).

Amounts come from either a fixed, published AWS list-price rate (EBS: no CUR, so this is the
closest deterministic estimate available — documented per rate) or directly from an AWS
recommendation API's own estimate (Compute Optimizer) — never invented by this code.
"""
from datetime import datetime, timedelta, timezone

import boto3

_REGION = "ap-northeast-2"

# Published AWS EBS $/GB-month list prices (ap-northeast-2, on-demand). This is a deterministic
# constant, not a CUR-derived actual — see the ADR-019 Context section: CUR/Athena don't exist in
# this repo, so an unattached volume's cost is estimated from its type+size against the published
# rate card, not read back from a bill line item. Kept IDENTICAL to diagnosis/sources.py's
# collect_idle() CASE table (the ADR-019 Context section names this exact duplication as one of the
# "three scattered places" it exists to eventually consolidate — this rule reuses the same numbers
# rather than adding a fourth, slightly different rate table to the pile).
_EBS_GB_MONTH_USD = {
    "gp3": 0.0912, "gp2": 0.114, "io1": 0.125, "io2": 0.125,
    "st1": 0.045, "sc1": 0.025, "default": 0.10,
}


def _co_client():
    return boto3.client("compute-optimizer", region_name=_REGION)


# Compute Optimizer opt-in/support-plan gating — the SAME known-benign error family ADR-012's
# aws_finops_mcp.py already special-cases (AccessDeniedException/OptInRequiredException/
# SubscriptionRequiredException => "not available", not a real failure). Matched by substring
# against the exception's str() since boto3 raises these as botocore.errorfactory classes whose
# name isn't always importable ahead of time; the same substring match already covers the class
# name because boto3 ClientError.__str__ includes it.
_NOT_OPTED_IN = ("AccessDeniedException", "OptInRequiredException", "SubscriptionRequiredException")


def _is_not_opted_in(exc):
    s = str(exc)
    return any(code in s for code in _NOT_OPTED_IN)


# inventory_resources is populated by the Steampipe inv_sync Lambda on a 15-min cadence when
# steampipe_enabled=true — but ADR-019 deliberately requires only workers_enabled, so
# finops_baseline can run with steampipe_enabled=false, or with a sync that has stopped updating.
# Either way, that must not be treated as "confirmed zero unattached volumes" (see
# _require_fresh_inventory below). NOTE: this must NOT be judged from inventory_resources row
# counts — a resource_type with genuinely zero live resources (e.g. an account with no EBS volumes
# at all) produces zero inventory_resources rows on a perfectly healthy, successful sync, which
# looked identical to "sync never ran" under an earlier version of this check and wrongly refused
# to resolve real stale findings forever. inventory_sync_runs is the correct signal: sync_lambda.py
# writes exactly one row per resource_type (keyed under the 'self' sentinel — a job-level ledger,
# not per scanned account) with status/finished_at/row_count, INCLUDING a `row_count=0,
# status='succeeded'` row when the sync ran fine and genuinely found nothing.
_INVENTORY_STALE_AFTER_HOURS = 24


def _require_fresh_inventory(conn, resource_type):
    """Raise (not return-empty) unless inventory_sync_runs shows a `succeeded` run for
    `resource_type` finished within _INVENTORY_STALE_AFTER_HOURS. No row / status != 'succeeded' /
    finished_at NULL or stale all mean "this rule cannot honestly evaluate this run" — letting the
    caller return [] here would make engine.run()'s resolve_stale wipe every real prior finding for
    the rule, mistaking absent/stale/failed sync state for a confirmed clean result (the same class
    of bug the Compute Optimizer rules fix for a different data source). A `succeeded` run with
    row_count=0 passes this check — that IS a trustworthy true zero, not treated as unavailable."""
    rows = conn.run(
        "SELECT status, finished_at FROM inventory_sync_runs WHERE resource_type = :rt AND account_id = 'self'",
        rt=resource_type,
    )
    if not rows:
        raise RuntimeError(
            f"inventory_sync_runs has no row for {resource_type!r} — Steampipe inv_sync is "
            f"disabled or has never run; treating as data-unavailable rather than 'confirmed none found'"
        )
    status, finished_at = rows[0]
    if status != "succeeded" or finished_at is None:
        raise RuntimeError(
            f"inventory_sync_runs for {resource_type!r} is status={status!r} (not a completed "
            f"succeeded run) — treating as data-unavailable rather than 'confirmed none found'"
        )
    if _is_stale(finished_at, _INVENTORY_STALE_AFTER_HOURS):
        raise RuntimeError(
            f"inventory_sync_runs for {resource_type!r} last succeeded at {finished_at} "
            f"(> {_INVENTORY_STALE_AFTER_HOURS}h ago) — treating as data-unavailable rather than "
            f"'confirmed none found'"
        )


def _is_stale(ts, hours):
    if ts is None:
        return True
    now = datetime.now(timezone.utc)
    ts_utc = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    return now - ts_utc > timedelta(hours=hours)


def ebs_unattached(conn, ce_calls):
    """Unattached (state='available') EBS volumes from the synced inventory. Pure storage cost —
    no compute is running against it. Reads inventory_resources directly (worker DB role), NOT the
    curated sql_reader view inventory_read_mcp.py uses — the same underlying detection signal
    (`state == 'available'`) as that tool's `find_unused_resources`, kept independently here because
    that tool is agent-chat-facing and this path must not depend on AgentCore being enabled.

    _require_fresh_inventory only proves the JOB as a whole succeeded recently — sync_lambda.py's
    own M5 guard deliberately PRESERVES (never prunes) an unreachable account's rows rather than
    deleting them, so a row can come back from a "succeeded" job while itself being weeks old
    (job-level success masking stale per-account data). Each row's own `captured_at` is therefore
    also checked here, per-row, and a stale one is demoted via the guard mechanism (visible,
    flagged `stale_inventory_data`, and — because it's still returned — protected from
    engine.run()'s resolve_stale, instead of being silently trusted as confirmed-current evidence
    or silently dropped from the seen-set and wrongly resolved)."""
    _require_fresh_inventory(conn, "ebs_volume")
    rows = conn.run(
        "SELECT resource_id, region, data, captured_at FROM inventory_resources "
        "WHERE resource_type = 'ebs_volume' AND data->>'state' = 'available'"
    )
    out = []
    for resource_id, region, data, captured_at in rows or []:
        size = data.get("size")
        vtype = (data.get("volume_type") or "").lower()
        rate = _EBS_GB_MONTH_USD.get(vtype, _EBS_GB_MONTH_USD["default"])
        savings = round(size * rate, 2) if size else None
        out.append({
            "resource_id": resource_id,
            "title": f"Unattached EBS volume {resource_id} ({size or '?'} GiB, {vtype})",
            "category": "storage",
            "monthly_savings_usd": savings,
            "evidence": {"region": region, "size_gib": size, "volume_type": vtype,
                         "rate_usd_per_gb_month": rate, "captured_at": str(captured_at)},
            "tags": data.get("tags") or {},
            "finding_reason": None,
            "stale": _is_stale(captured_at, _INVENTORY_STALE_AFTER_HOURS),
        })
    return out


# Safety bound on pagination — protects against a runaway loop on a malformed/looping nextToken,
# not a real-world account size limit (500 recommendations of either kind would be unusual).
_CO_MAX_PAGES = 5


def ec2_rightsizing(conn, ce_calls):
    """EC2 rightsizing via Compute Optimizer, paginated (a single maxResults=100 page silently
    truncated large accounts — the review that added this fix flagged it as "missing
    recommendations"). Registered as ITS OWN catalog rule (not merged with RDS) so that an error
    here does not also skip the RDS call, and — the more important half — so that engine.py's
    per-rule resolve_stale only ever resolves EC2-rightsizing findings against an EC2-rightsizing
    result set, never against a result set that silently dropped EC2 because the RDS call (or vice
    versa) happened to fail first inside a combined function.

    A genuine "not opted in to Compute Optimizer" error (AccessDenied/OptInRequired/
    SubscriptionRequired — ADR-012's own established list) is the correct, permanent, zero-findings
    state for an account that never opted in, so it degrades to an empty list here (safe to
    resolve-away any stale findings, since there is nothing left to find). Any OTHER exception
    (throttling, a transient AWS-side error, a malformed response) is NOT swallowed — it propagates
    to engine.py's per-rule try/except, which skips resolve_stale for this rule THIS RUN, leaving
    yesterday's real findings untouched instead of a transient blip wiping them ("falsely
    resolved" — the bug this replaces)."""
    co = _co_client()
    out = []
    token = None
    for _ in range(_CO_MAX_PAGES):
        try:
            kwargs = {"maxResults": 100}
            if token:
                kwargs["nextToken"] = token
            resp = co.get_ec2_instance_recommendations(**kwargs)
        except Exception as e:  # noqa: BLE001
            if _is_not_opted_in(e):
                return []
            raise
        for r in resp.get("instanceRecommendations", []):
            finding = r.get("finding")
            if finding not in ("OVER_PROVISIONED", "NOT_OPTIMIZED"):
                continue  # UNDER_PROVISIONED / OPTIMIZED are not cost-saving opportunities
            options = r.get("recommendationOptions") or []
            top = options[0] if options else {}
            savings = top.get("estimatedMonthlySavings", {}).get("value")
            arn = r.get("instanceArn", "")
            out.append({
                "resource_id": arn,
                "title": f"EC2 rightsizing: {r.get('currentInstanceType', '?')} -> "
                         f"{top.get('instanceType', '?')} ({r.get('instanceName') or arn.rsplit('/', 1)[-1]})",
                "category": "compute",
                "monthly_savings_usd": round(savings, 2) if isinstance(savings, (int, float)) else None,
                "evidence": {"current_type": r.get("currentInstanceType"), "recommended_type": top.get("instanceType"),
                             "finding": finding, "performance_risk": top.get("performanceRisk")},
                "tags": {t.get("key"): t.get("value") for t in (r.get("tags") or [])},
                "finding_reason": finding if finding == "INSUFFICIENT_DATA" else None,
            })
        token = resp.get("nextToken")
        if not token:
            break
    return out


def rds_rightsizing(conn, ce_calls):
    """RDS rightsizing via Compute Optimizer, paginated. See ec2_rightsizing's docstring — the
    same independent-rule + paginate + only-swallow-known-opt-out-errors reasoning applies here."""
    co = _co_client()
    out = []
    token = None
    for _ in range(_CO_MAX_PAGES):
        try:
            kwargs = {"maxResults": 100}
            if token:
                kwargs["nextToken"] = token
            resp = co.get_rds_database_recommendations(**kwargs)
        except Exception as e:  # noqa: BLE001
            if _is_not_opted_in(e):
                return []
            raise
        for r in resp.get("rdsDatabaseRecommendations", []):
            options = r.get("recommendationOptions") or []
            if not options:
                continue  # no recommendation option -> nothing actionable to show
            top = options[0]
            savings = top.get("estimatedMonthlySavings", {}).get("value")
            arn = r.get("resourceArn", "")
            out.append({
                "resource_id": arn,
                "title": f"RDS rightsizing: {r.get('currentDBInstanceClass', '?')} -> "
                         f"{top.get('dbInstanceClass', '?')} ({arn.rsplit(':', 1)[-1]})",
                "category": "database",
                "monthly_savings_usd": round(savings, 2) if isinstance(savings, (int, float)) else None,
                "evidence": {"current_class": r.get("currentDBInstanceClass"),
                             "recommended_class": top.get("dbInstanceClass"), "engine": r.get("engine")},
                "tags": {},
                "finding_reason": None,
            })
        token = resp.get("nextToken")
        if not token:
            break
    return out
