"""ADR-019 active rule implementations. Each rule is `(conn, ce_calls) -> list[dict]`, where
ce_calls is a single-element list used as a mutable int counter (this PR ships no CE-calling rule
yet, so it stays 0 for now — see catalog.py / ADR-019 for the current vs. planned source list).
Each item dict has: resource_id, title, category, monthly_savings_usd (float or None — NEVER 0 as
a stand-in for "unknown"), evidence (dict, JSON-serializable), tags (dict or None), lookback_days
(int or None, passed to guards.insufficient_observation — the real Compute Optimizer signal for
"not enough data yet", not a `finding` enum value).

Amounts come from either a fixed, published AWS list-price rate (EBS: no CUR, so this is the
closest deterministic estimate available — documented per rate) or directly from an AWS
recommendation API's own estimate (Compute Optimizer) — never invented by this code.

Compute Optimizer response shapes below were verified against botocore's own service model
(`botocore.session.get_session().get_service_model("compute-optimizer")`), not hand-derived —
an earlier version of this file guessed wrong on three separate axes (finding enum casing, the
savings field's nesting, and the entire RDS response shape), which a PR review caught."""
import os
from datetime import datetime, timedelta, timezone

import boto3

_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")

# Published AWS EBS $/GB-month list prices — **ap-northeast-2 (Seoul) only**, on-demand. This is a
# deterministic constant, not a CUR-derived actual — see the ADR-019 Context section: CUR/Athena
# don't exist in this repo, so an unattached volume's cost is estimated from its type+size against
# the published rate card, not read back from a bill line item. Kept IDENTICAL to
# diagnosis/sources.py's collect_idle() CASE table (the ADR-019 Context section names this exact
# duplication as one of the "three scattered places" it exists to eventually consolidate — this
# rule reuses the same numbers rather than adding a fourth, slightly different rate table to the
# pile). A PR review caught that this table was being applied to EVERY synced account/region
# (inventory_resources spans all of them) as if it were a universal rate — see _PRICED_REGIONS.
# NOTE: no "default" key — a later review round caught that falling back to an invented rate for
# an unrecognized/future volume type (inherited from diagnosis/sources.py's ELSE 0.10 CASE, which
# predates this ADR's "amounts are never invented" invariant) produced a confident dollar amount
# for something genuinely unpriced, exactly the failure mode _PRICED_REGIONS exists to prevent for
# regions. An unlisted type now gets the same NULL + evidence-marker treatment as an unpriced
# region (see the lookup below), never a guessed number.
_EBS_GB_MONTH_USD = {
    "gp3": 0.0912, "gp2": 0.114, "io1": 0.125, "io2": 0.125,
    "st1": 0.045, "sc1": 0.025,
}

# Only ap-northeast-2 has a published rate in _EBS_GB_MONTH_USD above — pricing a us-east-1 (or any
# other) volume against Korea list rates would present a confident, wrong dollar amount, in direct
# tension with this ADR's own "amounts are never invented" invariant. A row outside this set still
# surfaces (never silently hidden — the ADR's discard-hiding-is-worse-than-honest-NULL discipline),
# but with monthly_savings_usd=None rather than a misleading number.
_PRICED_REGIONS = {"ap-northeast-2"}


def _co_client():
    return boto3.client("compute-optimizer", region_name=_REGION)


# A review round correctly caught that AccessDeniedException must not degrade to an empty (and
# therefore "confirmed clean") result — it is exactly as likely to mean "an IAM/SCP policy
# regressed" as anything else (this ADR itself exists partly because a Cost Optimization Hub
# AccessDenied went unnoticed for months — see the CHANGELOG entry). A LATER review round caught
# that OptInRequiredException/SubscriptionRequiredException deserve the identical treatment: an
# opt-out (or a support-plan lapse) is a DATA-AVAILABILITY state, not evidence that yesterday's
# real EC2/RDS rightsizing findings were fixed. Every Compute Optimizer exception — opt-out,
# AccessDenied, throttling, a malformed response, page-bound truncation — therefore now propagates
# uniformly to engine.py's per-rule try/except, which marks the run `partial` and skips
# resolve_stale for this rule THIS RUN, leaving yesterday's real findings untouched instead of a
# transient (or permanent-but-still-not-"confirmed-clean") state wiping them.


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
        "SELECT resource_id, account_id, region, data, captured_at FROM inventory_resources "
        "WHERE resource_type = 'ebs_volume' AND data->>'state' = 'available'"
    )
    out = []
    for resource_id, account_id, region, data, captured_at in rows or []:
        size = data.get("size")
        vtype = (data.get("volume_type") or "").lower()
        rate = _EBS_GB_MONTH_USD.get(vtype) if region in _PRICED_REGIONS else None
        savings = round(size * rate, 2) if (rate is not None and size) else None
        evidence = {"account_id": account_id, "region": region, "size_gib": size, "volume_type": vtype,
                    "rate_usd_per_gb_month": rate, "captured_at": str(captured_at)}
        if region not in _PRICED_REGIONS:
            evidence["unpriced_region"] = region
        elif rate is None:
            evidence["unpriced_volume_type"] = vtype
        out.append({
            "resource_id": resource_id,
            "account_id": account_id,
            "region": region,
            "title": f"Unattached EBS volume {resource_id} ({size or '?'} GiB, {vtype})",
            "category": "storage",
            "monthly_savings_usd": savings,
            "evidence": evidence,
            "tags": data.get("tags") or {},
            "lookback_days": None,  # not a Compute Optimizer finding — this guard never applies here
            "stale": _is_stale(captured_at, _INVENTORY_STALE_AFTER_HOURS),
        })
    out.extend(_ebs_stale_account_coverage_gaps(conn))
    return out


def _ebs_stale_account_coverage_gaps(conn):
    """Covers TWO false-clean coverage gaps a review round caught the per-row stale guard above
    cannot see — both leave an account looking "confirmed no waste" when the truth is "never
    checked":

    1. STALE scope: `WHERE data->>'state' = 'available'` is evaluated against a SNAPSHOT — if an
       account's whole ebs_volume snapshot is stale (sync_lambda.py's M5 guard preserves an
       unreachable account's rows rather than pruning them), a volume that was `in-use` at
       snapshot time and has since become genuinely unattached produces NO row here at all: no
       finding, no guard, no coverage signal, while the run still records `succeeded`.
    2. NEVER-SYNCED scope: an `enabled` account in the `accounts` registry whose Steampipe
       connection has never once succeeded has ZERO ebs_volume rows in inventory_resources —
       indistinguishable, by row absence alone, from "confirmed zero EBS volumes." Only
       cross-referencing the account registry (rows that SHOULD exist) can surface this; the
       stale-timestamp check above sees nothing to compare against.

    Neither can be fixed by re-deriving "is it unattached now" from data that was never captured
    or is too old — the only honest fix is to surface the coverage gap itself, so a viewer can
    tell "confirmed no waste" apart from "this account's data is missing or too old to know."
    Emits one coverage-gap item per gap (NULL amount, `stale=True` so the existing
    stale_inventory_data guard covers it, never counted as `active` savings)."""
    rows = conn.run(
        "SELECT account_id, region, MAX(captured_at) FROM inventory_resources "
        "WHERE resource_type = 'ebs_volume' GROUP BY account_id, region"
    )
    seen_accounts = set()
    out = []
    for account_id, region, latest_captured_at in rows or []:
        seen_accounts.add(account_id)
        if not _is_stale(latest_captured_at, _INVENTORY_STALE_AFTER_HOURS):
            continue
        out.append({
            "resource_id": f"__coverage_gap__:stale:{account_id}:{region}",
            "account_id": account_id,
            "region": region,
            "title": f"EBS inventory data for {account_id}/{region} is stale — unattached-volume "
                     f"coverage may be incomplete",
            "category": "storage",
            "monthly_savings_usd": None,
            "evidence": {"account_id": account_id, "region": region,
                         "latest_captured_at": str(latest_captured_at), "coverage_gap": True},
            "tags": {},
            "lookback_days": None,
            "stale": True,
        })
    for account_id, region in conn.run("SELECT account_id, region FROM accounts WHERE enabled = true") or []:
        if account_id in seen_accounts:
            continue
        out.append({
            "resource_id": f"__coverage_gap__:never_synced:{account_id}",
            "account_id": account_id,
            "region": region,
            "title": f"No EBS inventory data has ever been synced for account {account_id} — "
                     f"unattached-volume coverage is entirely unavailable",
            "category": "storage",
            "monthly_savings_usd": None,
            "evidence": {"account_id": account_id, "region": region, "coverage_gap": True,
                         "never_synced": True},
            "tags": {},
            "lookback_days": None,
            "stale": True,
        })
    return out


# Safety bound on pagination — protects against a runaway loop on a malformed/looping nextToken,
# not a real-world account size limit (500 recommendations of either kind would be unusual). If
# the bound is hit and a nextToken is STILL present, the result is a silent partial truncation —
# raising (not returning the partial list) so engine.py skips resolve_stale for this run rather
# than resolving everything past page 5 as if it no longer existed.
_CO_MAX_PAGES = 5

# `lookBackPeriodInDays`/`lookbackPeriodInDays` (passed through as `lookback_days` below) is the
# REAL per-recommendation "not enough data yet" signal — there is no "INSUFFICIENT_DATA" value in
# either API's `finding` enum (verified against botocore's service model); an earlier version of
# this file checked for one that can never appear, making guards.insufficient_observation
# permanently dead code. The actual threshold lives in guards.py, next to the guard itself.


def _co_page(get_fn, list_key):
    """Shared pagination helper: yields each page's raw response dict. Raises RuntimeError if the
    page bound is hit with a nextToken still present (truncated, not exhausted) — see _CO_MAX_PAGES.

    Also raises on a non-empty `errors` array (verified present on both GetEC2InstanceRecommendations
    and GetRDSDatabaseRecommendations via botocore's service model: `GetRecommendationError` with
    identifier/code/message). A review round caught that this in-band per-object/per-account failure
    channel was silently ignored — the HTTP call succeeds, some resources are missing from the
    result for a reason the response itself reports, and without this check that missing coverage
    reads as "confirmed none found" and resolve_stale wipes real prior findings for it — the exact
    failure class this file's exception-propagation-over-degrading design otherwise prevents."""
    token = None
    for i in range(_CO_MAX_PAGES):
        kwargs = {"maxResults": 100}
        if token:
            kwargs["nextToken"] = token
        resp = get_fn(**kwargs)
        errors = resp.get("errors") or []
        if errors:
            raise RuntimeError(
                f"{list_key} response reported {len(errors)} in-band error(s) — e.g. "
                f"{errors[0].get('code')}: {errors[0].get('message')} — treating the result as "
                f"incomplete rather than a confirmed full list"
            )
        yield resp
        token = resp.get("nextToken")
        if not token:
            return
    raise RuntimeError(
        f"{list_key} pagination hit the {_CO_MAX_PAGES}-page safety bound with a nextToken still "
        f"present — result is a silent partial truncation, not a complete list"
    )


def ec2_rightsizing(conn, ce_calls):
    """EC2 rightsizing via Compute Optimizer, paginated (a single maxResults=100 page silently
    truncated large accounts). Registered as ITS OWN catalog rule (not merged with RDS) so that an
    error here does not also skip the RDS call, and — the more important half — so that
    engine.py's per-rule resolve_stale only ever resolves EC2-rightsizing findings against an
    EC2-rightsizing result set, never against a result set that silently dropped EC2 because the
    RDS call (or vice versa) happened to fail first inside a combined function.

    Every exception (opt-out, AccessDenied, throttling, a transient AWS-side error, a malformed
    response, page-bound truncation) propagates uniformly to engine.py's per-rule try/except,
    which marks the run `partial` and skips resolve_stale for this rule THIS RUN, leaving
    yesterday's real findings untouched instead of some being wiped by a state that looks like
    "confirmed clean" but isn't ("falsely resolved" — the bug a PR review caught this rule doing
    under the wrong enum values anyway, since the finding filter below never matched anything
    before that fix)."""
    co = _co_client()
    out = []
    for resp in _co_page(co.get_ec2_instance_recommendations, "EC2"):
        for r in resp.get("instanceRecommendations", []):
            # Wire values are CamelCase (verified against botocore's service model), not the
            # SCREAMING_SNAKE_CASE an earlier version of this file guessed — that guess matched
            # zero rows, ever.
            finding = r.get("finding")
            if finding not in ("Overprovisioned", "NotOptimized"):
                continue  # Underprovisioned / Optimized are not cost-saving opportunities
            options = sorted(r.get("recommendationOptions") or [], key=lambda o: o.get("rank", 999))
            top = options[0] if options else {}
            savings = (top.get("savingsOpportunity") or {}).get("estimatedMonthlySavings", {}).get("value")
            arn = r.get("instanceArn", "")
            out.append({
                "resource_id": arn,
                "account_id": "self",  # Compute Optimizer is called against the host account only
                "region": _REGION,
                "title": f"EC2 rightsizing: {r.get('currentInstanceType', '?')} -> "
                         f"{top.get('instanceType', '?')} ({r.get('instanceName') or arn.rsplit('/', 1)[-1]})",
                "category": "compute",
                "monthly_savings_usd": round(savings, 2) if isinstance(savings, (int, float)) else None,
                "evidence": {"current_type": r.get("currentInstanceType"), "recommended_type": top.get("instanceType"),
                             "finding": finding, "performance_risk": top.get("performanceRisk"),
                             "lookback_days": r.get("lookBackPeriodInDays")},
                "tags": {t.get("key"): t.get("value") for t in (r.get("tags") or [])},
                "lookback_days": r.get("lookBackPeriodInDays"),
            })
    return out


def rds_rightsizing(conn, ce_calls):
    """RDS rightsizing via Compute Optimizer, paginated. See ec2_rightsizing's docstring — the
    same independent-rule + paginate + let-every-exception-propagate reasoning applies here.
    NOTE: the response shape is NOT a copy of the EC2 one — `GetRDSDatabaseRecommendations`
    returns `rdsDBRecommendations` with `instanceRecommendationOptions` and a SEPARATE
    `instanceFinding`/`storageFinding` pair (verified against botocore's service model); an earlier
    version of this file assumed the EC2 field names and iterated zero rows, ever."""
    co = _co_client()
    out = []
    for resp in _co_page(co.get_rds_database_recommendations, "RDS"):
        for r in resp.get("rdsDBRecommendations", []):
            finding = r.get("instanceFinding")
            if finding != "Overprovisioned":
                # Underprovisioned is an upscale recommendation — not a savings opportunity;
                # surfacing it here (as an earlier version of this file did unconditionally)
                # would show "recommend a BIGGER instance" as a cost-saving finding.
                continue
            options = sorted(r.get("instanceRecommendationOptions") or [], key=lambda o: o.get("rank", 999))
            if not options:
                continue  # no recommendation option -> nothing actionable to show
            top = options[0]
            savings = (top.get("savingsOpportunity") or {}).get("estimatedMonthlySavings", {}).get("value")
            arn = r.get("resourceArn", "")
            out.append({
                "resource_id": arn,
                "account_id": "self",  # Compute Optimizer is called against the host account only
                "region": _REGION,
                "title": f"RDS rightsizing: {r.get('currentDBInstanceClass', '?')} -> "
                         f"{top.get('dbInstanceClass', '?')} ({arn.rsplit(':', 1)[-1]})",
                "category": "database",
                "monthly_savings_usd": round(savings, 2) if isinstance(savings, (int, float)) else None,
                "evidence": {"current_class": r.get("currentDBInstanceClass"),
                             "recommended_class": top.get("dbInstanceClass"), "engine": r.get("engine"),
                             "finding": finding, "lookback_days": r.get("lookbackPeriodInDays")},
                "tags": {t.get("key"): t.get("value") for t in (r.get("tags") or [])},
                "lookback_days": r.get("lookbackPeriodInDays"),
            })
    return out
