"""SG Rules & Usage — daily scan handler (`sg_rule_scan` job, Fargate runtime).

Per source, in order (design spec's "Daily pipeline" section):
  1. validate the saved source metadata (sg_flow_sources)
  2. snapshot current SGRs (DescribeSecurityGroupRules) + ENI-SG memberships
     (DescribeNetworkInterfaces) -> upsert sg_rule_inventory + append-only
     sg_rule_inventory_versions
  3. compute the next unprocessed completed UTC day, honoring SG_RULE_DELIVERY_LAG_HOURS
  4. ONE Athena query for that account/region/day via the isolated broker Lambda
     (sg_rule_athena_broker.py — this module never assumes AWSopsSgRuleAthenaRole itself)
  5. select/aggregate only the fields needed
  6. match accepted flows against candidate rules (sg_rule_matching.py)
  7. one transaction: delete+insert that day's sg_rule_activity_daily rows, write
     sg_rule_scan_runs coverage
  8. advance the watermark only after the transaction commits
  9. separately, re-run the trailing SG_RULE_RESCAN_WINDOW_DAYS as an idempotent re-run (never
     moves the watermark backward)

Cross-account access uses TWO separate roles, never conflated (ADR-019 §4):
  - Role A (rule inventory / ENI describe): the existing, reused AWSopsReadOnlyRole — the SAME
    trust boundary the web task role / Steampipe task role / agent Lambda already assume.
  - Role B (Athena query): the isolated AWSopsSgRuleAthenaRole, assumed ONLY by the broker Lambda
    (sg_rule_athena_broker.py) — this module talks to the broker via lambda:InvokeFunction, never
    assumes that role directly.
"""
import datetime as dt
import json
import os
import uuid

import boto3

import sg_rule_matching as sm

DELIVERY_LAG_HOURS = int(os.environ.get("SG_RULE_DELIVERY_LAG_HOURS", "6"))
MEMBERSHIP_STALENESS_DAYS = int(os.environ.get("SG_RULE_MEMBERSHIP_STALENESS_DAYS", "3"))
RESCAN_WINDOW_DAYS = int(os.environ.get("SG_RULE_RESCAN_WINDOW_DAYS", "2"))
MAX_QUERY_BYTES = int(os.environ.get("SG_RULE_ACTIVITY_MAX_QUERY_BYTES", "107374182400"))
HOST_ACCOUNT_ID = os.environ.get("AWS_ACCOUNT_ID", "")
READONLY_ROLE_NAME = "AWSopsReadOnlyRole"


class SourceNotConfigured(Exception):
    pass


class SourceInvalid(Exception):
    pass


# ── Source metadata + cross-account clients (Role A) ─────────────────────────────────────────────

def load_source(conn, account_id, region):
    rows = conn.run(
        "SELECT id, account_id, region, workgroup, database_name, table_name, enabled, validation, "
        "created_at FROM sg_flow_sources WHERE account_id=:a AND region=:r",
        a=account_id, r=region)
    if not rows:
        raise SourceNotConfigured(f"no sg_flow_sources row for {account_id}/{region}")
    cols = ["id", "account_id", "region", "workgroup", "database_name", "table_name", "enabled",
            "validation", "created_at"]
    row = dict(zip(cols, rows[0]))
    if not row["enabled"]:
        raise SourceNotConfigured(f"source {account_id}/{region} is disabled")
    validation = row["validation"]
    if isinstance(validation, str):
        try:
            validation = json.loads(validation)
        except (ValueError, TypeError):
            validation = {}
    row["validation"] = validation or {}
    if row["validation"].get("status") not in ("valid", "pending"):
        # 'invalid'/'error'/'unconfigured' — do not scan against a known-bad source config.
        raise SourceInvalid(f"source {account_id}/{region} failed validation: {row['validation']}")
    return row


def _assumed_session(account_id, region, role_name, external_id=None):
    if account_id == HOST_ACCOUNT_ID:
        return boto3.Session(region_name=region)
    sts = boto3.client("sts", region_name=region)
    kwargs = {
        "RoleArn": f"arn:aws:iam::{account_id}:role/{role_name}",
        "RoleSessionName": "awsops-sg-rule-scan", "DurationSeconds": 3600,
    }
    if external_id:
        kwargs["ExternalId"] = external_id
    creds = sts.assume_role(**kwargs)["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"], region_name=region,
    )


def readonly_ec2_client(account_id, region, external_id=None):
    """Role A — the existing, reused AWSopsReadOnlyRole pattern (workload.tf/steampipe.tf/ai.tf)."""
    return _assumed_session(account_id, region, READONLY_ROLE_NAME, external_id).client("ec2")


def account_external_id(conn, account_id):
    rows = conn.run("SELECT external_id FROM accounts WHERE account_id=:a", a=account_id)
    return rows[0][0] if rows else None


# ── Step 2: SGR + ENI-membership snapshot ─────────────────────────────────────────────────────────

def _perm_to_rules(perm, group_id, is_egress):
    protocol = "all" if perm.get("IpProtocol") == "-1" else sm.PROTO_NAME.get(str(perm.get("IpProtocol")), str(perm.get("IpProtocol")))
    base = {"group_id": group_id, "is_egress": is_egress, "protocol": protocol,
            "from_port": perm.get("FromPort"), "to_port": perm.get("ToPort")}
    out = []
    for r in perm.get("IpRanges", []) or []:
        out.append({**base, "peer_kind": "cidr", "peer_value": r.get("CidrIp", ""), "description": r.get("Description")})
    for r in perm.get("Ipv6Ranges", []) or []:
        out.append({**base, "peer_kind": "cidr", "peer_value": r.get("CidrIpv6", ""), "description": r.get("Description")})
    for r in perm.get("UserIdGroupPairs", []) or []:
        out.append({**base, "peer_kind": "sg", "peer_value": r.get("GroupId", ""), "description": r.get("Description")})
    for r in perm.get("PrefixListIds", []) or []:
        out.append({**base, "peer_kind": "pl", "peer_value": r.get("PrefixListId", ""), "description": r.get("Description")})
    return out


def snapshot_rules_via_describe(ec2):
    """Uses DescribeSecurityGroupRules (paginated) directly — never reconstructs sgr-* IDs from
    DescribeSecurityGroups, per the spec's Rule inventory section."""
    rules = []
    token = None
    while True:
        kwargs = {"MaxResults": 200}
        if token:
            kwargs["NextToken"] = token
        resp = ec2.describe_security_group_rules(**kwargs)
        for r in resp.get("SecurityGroupRules", []):
            peer_kind, peer_value = None, None
            if r.get("CidrIpv4"):
                peer_kind, peer_value = "cidr", r["CidrIpv4"]
            elif r.get("CidrIpv6"):
                peer_kind, peer_value = "cidr", r["CidrIpv6"]
            elif r.get("ReferencedGroupInfo"):
                peer_kind, peer_value = "sg", r["ReferencedGroupInfo"].get("GroupId", "")
            elif r.get("PrefixListId"):
                peer_kind, peer_value = "pl", r["PrefixListId"]
            protocol = "all" if r.get("IpProtocol") == "-1" else sm.PROTO_NAME.get(str(r.get("IpProtocol")), str(r.get("IpProtocol")))
            rules.append({
                "rule_id": r["SecurityGroupRuleId"], "group_id": r["GroupId"],
                "is_egress": bool(r.get("IsEgress")), "protocol": protocol,
                "from_port": r.get("FromPort"), "to_port": r.get("ToPort"),
                "peer_kind": peer_kind, "peer_value": peer_value or "",
                "description": r.get("Description"),
            })
        token = resp.get("NextToken")
        if not token:
            break
    return rules


def snapshot_eni_membership_via_describe(ec2):
    memberships = []
    token = None
    count = 0
    while True:
        kwargs = {"MaxResults": 1000}
        if token:
            kwargs["NextToken"] = token
        resp = ec2.describe_network_interfaces(**kwargs)
        for eni in resp.get("NetworkInterfaces", []):
            ips = [p.get("PrivateIpAddress") for p in eni.get("PrivateIpAddresses", []) if p.get("PrivateIpAddress")]
            memberships.append({
                "vpc_id": eni.get("VpcId", ""), "eni_id": eni.get("NetworkInterfaceId", ""),
                "group_ids": [g.get("GroupId") for g in eni.get("Groups", []) if g.get("GroupId")],
                "private_ips": ips,
            })
        count += len(resp.get("NetworkInterfaces", []))
        token = resp.get("NextToken")
        if not token or count >= 20000:
            break
    return memberships


# ── Step 2: upsert sg_rule_inventory + append-only versions ──────────────────────────────────────

def upsert_inventory_and_versions(conn, account_id, region, rules, now):
    """Per rule: upsert the current-state cache (sg_rule_inventory) and, only when the freshly
    computed fingerprint differs from the currently-open version, close the old version and open a
    new one in sg_rule_inventory_versions (append-only). A rule seen for the first time gets its
    first version row with valid_from = now (approximating first_seen_at, since this IS the first
    observation)."""
    seen_ids = []
    for rule in rules:
        fp = sm.rule_fingerprint(rule)
        seen_ids.append(rule["rule_id"])
        conn.run(
            "INSERT INTO sg_rule_inventory "
            "(account_id, region, rule_id, group_id, is_egress, protocol, from_port, to_port, "
            " peer_kind, peer_value, description, fingerprint, first_seen_at, last_seen_at, active) "
            "VALUES (:a,:r,:rid,:gid,:eg,:proto,:fp_,:tp,:pk,:pv,:desc,:fp,:now,:now,true) "
            "ON CONFLICT (account_id, region, rule_id) DO UPDATE SET "
            "group_id=EXCLUDED.group_id, is_egress=EXCLUDED.is_egress, protocol=EXCLUDED.protocol, "
            "from_port=EXCLUDED.from_port, to_port=EXCLUDED.to_port, peer_kind=EXCLUDED.peer_kind, "
            "peer_value=EXCLUDED.peer_value, description=EXCLUDED.description, "
            "fingerprint=EXCLUDED.fingerprint, last_seen_at=:now, active=true",
            a=account_id, r=region, rid=rule["rule_id"], gid=rule["group_id"], eg=rule["is_egress"],
            proto=rule["protocol"], fp_=rule.get("from_port"), tp=rule.get("to_port"),
            pk=rule["peer_kind"], pv=rule["peer_value"], desc=rule.get("description"), fp=fp, now=now,
        )
        open_rows = conn.run(
            "SELECT fingerprint FROM sg_rule_inventory_versions "
            "WHERE account_id=:a AND region=:r AND rule_id=:rid AND valid_to IS NULL",
            a=account_id, r=region, rid=rule["rule_id"])
        if not open_rows:
            conn.run(
                "INSERT INTO sg_rule_inventory_versions "
                "(account_id, region, rule_id, fingerprint, group_id, is_egress, protocol, from_port, "
                " to_port, peer_kind, peer_value, valid_from, valid_to) "
                "VALUES (:a,:r,:rid,:fp,:gid,:eg,:proto,:fp_,:tp,:pk,:pv,:now,NULL)",
                a=account_id, r=region, rid=rule["rule_id"], fp=fp, gid=rule["group_id"],
                eg=rule["is_egress"], proto=rule["protocol"], fp_=rule.get("from_port"),
                tp=rule.get("to_port"), pk=rule["peer_kind"], pv=rule["peer_value"], now=now)
        elif open_rows[0][0] != fp:
            conn.run(
                "UPDATE sg_rule_inventory_versions SET valid_to=:now "
                "WHERE account_id=:a AND region=:r AND rule_id=:rid AND valid_to IS NULL",
                a=account_id, r=region, rid=rule["rule_id"], now=now)
            conn.run(
                "INSERT INTO sg_rule_inventory_versions "
                "(account_id, region, rule_id, fingerprint, group_id, is_egress, protocol, from_port, "
                " to_port, peer_kind, peer_value, valid_from, valid_to) "
                "VALUES (:a,:r,:rid,:fp,:gid,:eg,:proto,:fp_,:tp,:pk,:pv,:now,NULL)",
                a=account_id, r=region, rid=rule["rule_id"], fp=fp, gid=rule["group_id"],
                eg=rule["is_egress"], proto=rule["protocol"], fp_=rule.get("from_port"),
                tp=rule.get("to_port"), pk=rule["peer_kind"], pv=rule["peer_value"], now=now)
    # Sweep disappeared rules — ALWAYS runs, even when `rules` (this snapshot) is empty (fix for the
    # MAJOR "disappeared rules' open version rows never closed" finding: an empty snapshot for a
    # source that previously had rules means ALL of them disappeared, not "no update needed" — the
    # old `if seen_ids:` guard skipped this sweep entirely on an empty snapshot, which is exactly
    # backwards). `rule_id <> ALL(:seen)` with an empty `seen` array is vacuously true for every row,
    # which is the correct behavior here (every previously-known rule has disappeared).
    conn.run(
        "UPDATE sg_rule_inventory SET active=false "
        "WHERE account_id=:a AND region=:r AND rule_id <> ALL(:seen)",
        a=account_id, r=region, seen=seen_ids)
    # Close the open version epoch for any rule that disappeared from this snapshot — a rule that no
    # longer exists can never re-open its own version row, and leaving valid_to NULL would let it
    # keep matching flows forever (the same MAJOR finding).
    conn.run(
        "UPDATE sg_rule_inventory_versions SET valid_to=:now "
        "WHERE account_id=:a AND region=:r AND valid_to IS NULL AND rule_id <> ALL(:seen)",
        a=account_id, r=region, now=now, seen=seen_ids)


def write_eni_snapshot(conn, account_id, region, memberships, now):
    for mship in memberships:
        conn.run(
            "INSERT INTO sg_eni_membership_snapshots "
            "(account_id, region, vpc_id, observed_at, eni_id, group_ids, private_ips) "
            "VALUES (:a,:r,:vpc,:now,:eni,:gids::jsonb,:ips::jsonb) "
            "ON CONFLICT (account_id, region, observed_at, eni_id) DO NOTHING",
            a=account_id, r=region, vpc=mship["vpc_id"], now=now, eni=mship["eni_id"],
            gids=json.dumps(mship["group_ids"]), ips=json.dumps(mship["private_ips"]))


# ── Step 3: watermark ─────────────────────────────────────────────────────────────────────────────

def last_committed_day(conn, flow_source_id):
    rows = conn.run(
        "SELECT max(partition_start::date) FROM sg_rule_scan_runs "
        "WHERE flow_source_id=:fid AND status='succeeded'", fid=flow_source_id)
    return rows[0][0] if rows and rows[0][0] else None


# ── Step 4-6: Athena query + matching for one day ─────────────────────────────────────────────────

def _safe_ident(name, fallback):
    """Defense-in-depth re-validation (MAJOR L3 finding) of a column-name identifier that
    ultimately came from web/lib/sg-rules.ts's persisted `validation.columnMap` (itself sourced
    from a Glue DescribeTable response the broker already re-validated against a strict alias
    allowlist in `_validate`). Never trust a stored value blindly when it's about to be
    string-interpolated into SQL — re-check the same shape (Glue/Athena identifier charset) here,
    a second, structurally different check in a different process, same pattern as the broker's
    own `_reject_non_select`."""
    import re
    # Allows '-' too: AWS's own default VPC Flow Log Athena tables name columns like
    # "interface-id"/"log-status" (hyphenated) — the broker's own alias allowlist (`_validate`)
    # accepts exactly this same charset.
    candidate = name if isinstance(name, str) and re.match(r'^[A-Za-z_][A-Za-z0-9_-]{0,127}$', name) else fallback
    return candidate


def build_day_select(source, day):
    """Validated SELECT for one account/region/day. Every identifier here is re-validated
    (`_safe_ident`) before interpolation; workgroup/database/table already passed strict allowlist
    regexes at PUT time (web/lib/sg-rules.ts) and the broker's own `_validate` re-resolves the exact
    column ALIASES actually present in the table (persisted as `validation.columnMap`, canonical ->
    actual name — e.g. `interface_id` -> `interface-id`) — this function must use THAT resolved
    mapping instead of assuming underscore names (MAJOR finding: the old version hardcoded
    `interface_id`/`log_status` even though validation deliberately accepts hyphenated aliases too).
    `bytes` is conditional on `validation.optionalFields` (validation classifies it optional, not
    guaranteed present) and a partition predicate is added whenever validation resolved partition
    key names (validation refuses to certify a table it cannot bound — this function must actually
    use that bound, not just rely on the `start` filter alone, which doesn't prune partitions).
    The only literals interpolated below are ISO day boundaries the worker itself computed (never
    user input) and identifiers that passed `_safe_ident`."""
    validation = source.get("validation") or {}
    column_map = validation.get("columnMap") or {}
    optional_fields = set(validation.get("optionalFields") or [])
    partition_keys = validation.get("partitionKeys") or []

    interface_col = _safe_ident(column_map.get("interface_id"), "interface_id")
    log_status_col = _safe_ident(column_map.get("log_status"), "log_status")
    start_col = _safe_ident(column_map.get("start"), "start")

    start, end = sm.day_bounds_utc(day)
    table = f'"{source["database_name"]}"."{source["table_name"]}"'

    # `bytes` is an OPTIONAL Flow Log field (custom-format tables may omit it) — only select/sum it
    # when validation actually found the column; never assume it unconditionally (MAJOR finding).
    # When validation hasn't run yet (a 'pending' source, no columnMap/optionalFields at all) fall
    # back to the pre-existing assume-present behavior rather than silently dropping bytes evidence.
    has_optional_info = bool(column_map) or bool(optional_fields)
    has_bytes = ("bytes" in optional_fields) if has_optional_info else True
    bytes_select = ', sum("bytes") as bytes' if has_bytes else ''

    # Partition predicate: bound the scan to this UTC day's partition whenever validation resolved
    # actual partition key names (never emit an unbounded full-table scan when a bound is knowable).
    # Recognizes the two common Glue/Athena VPC Flow Log partitioning conventions: Hive-style
    # year/month/day pseudo-columns, or a single date-typed partition key.
    partition_predicate = ""
    lower_keys = {k.lower(): k for k in partition_keys}
    if {"year", "month", "day"} <= set(lower_keys):
        y, mo, d = lower_keys["year"], lower_keys["month"], lower_keys["day"]
        partition_predicate = (
            f' AND "{_safe_ident(y, "year")}" = \'{day.year:04d}\''
            f' AND "{_safe_ident(mo, "month")}" = \'{day.month:02d}\''
            f' AND "{_safe_ident(d, "day")}" = \'{day.day:02d}\''
        )
    elif len(partition_keys) == 1:
        dk = _safe_ident(partition_keys[0], "")
        if dk:
            partition_predicate = f' AND "{dk}" = \'{day.isoformat()}\''

    return (
        f'SELECT "{interface_col}" as interface_id, srcaddr, dstaddr, srcport, dstport, protocol, '
        f'action{bytes_select}, count(*) as cnt, max("{start_col}") as last_start FROM {table} '
        f'WHERE "{start_col}" >= {int(start.timestamp())} AND "{start_col}" < {int(end.timestamp())} '
        f"AND action = 'ACCEPT' AND \"{log_status_col}\" = 'OK'{partition_predicate} "
        f'GROUP BY "{interface_col}", srcaddr, dstaddr, srcport, dstport, protocol, action '
        f"LIMIT 200000"
    )


def invoke_broker_query(lambda_client, broker_arn, account_id, region, external_id, source, day):
    payload = {
        "action": "query", "account_id": account_id, "region": region, "external_id": external_id,
        "workgroup": source["workgroup"], "database": source["database_name"],
        "query": build_day_select(source, day), "max_bytes": MAX_QUERY_BYTES,
    }
    resp = lambda_client.invoke(FunctionName=broker_arn, Payload=json.dumps(payload).encode("utf-8"))
    body = json.loads((resp.get("Payload").read() if hasattr(resp.get("Payload"), "read") else resp.get("Payload")) or b"{}")
    # MINOR fix: surface an unhandled broker crash (FunctionError set, or a body that isn't the
    # broker's own {"ok": ...} shape) as a diagnosable failure instead of a bare
    # {"status":"failed","reason":None} the caller can't act on.
    if resp.get("FunctionError") or "ok" not in body:
        return {"ok": False, "reason": f"broker invocation error: FunctionError={resp.get('FunctionError')!r}, body={body!r}"}
    return body


def eni_group_ids_for_ip(memberships, ip):
    """memberships: list of {eni_id, group_ids, private_ips} for the resolved snapshot. Returns the
    union of group_ids of any ENI carrying `ip`."""
    gids = set()
    for m in memberships:
        if ip in (m.get("private_ips") or []):
            gids.update(m.get("group_ids") or [])
    return gids


def process_day(conn, source, day, flows, rule_versions_by_id, memberships_by_vpc, earliest_snapshot_at):
    """Matches `flows` (already-aggregated Athena rows) against every rule for this account/region,
    classifies the whole day per rule, and commits sg_rule_activity_daily + sg_rule_scan_runs in
    ONE transaction (delete-then-insert for the day — idempotent regardless of how many times this
    day is reprocessed). Returns the coverage summary dict.

    CRITICAL fix: a flow may only be credited to a rule whose `group_id` is actually carried by the
    flow's OWN ENI (`flow["interface_id"]`, selected by the Athena query but previously never read)
    — resolved via an eni_id -> {group_ids, private_ips, vpc_id} index built once from
    `memberships_by_vpc` (also fixes the MINOR "VPC lookup inside the innermost loop" complexity
    note, and the MINOR "unique_eni_count counts destination IP strings, not ENIs" — it now counts
    the flow's own interface_id). Direction ("ingress"/"egress") and which side of the flow tuple is
    the local peer are derived from whether the ENI's own private_ips contain srcaddr or dstaddr —
    never guessed from dstaddr alone (fixes the MAJOR "direction hardcoded ingress" finding; every
    egress rule is now matchable). A flow whose ENI cannot be resolved (no membership snapshot
    covers it) contributes no evidence to any rule — it is never fabricated.
    """
    account_id, region = source["account_id"], source["region"]
    day_str = day.isoformat()
    run_id = str(uuid.uuid4())
    start, end = sm.day_bounds_utc(day)

    per_rule = {}
    any_crossing = False
    for rule_id, versions in rule_versions_by_id.items():
        day_cov = sm.day_coverage(versions, day)
        per_rule[rule_id] = {
            "compatible": 0, "overlap": 0, "bytes": 0,
            "unassessable": day_cov["crossing"],  # fingerprint-epoch-crossing (day-level)
            "match_unassessable": False,          # any flow evaluated UNASSESSABLE (pl/icmp/etc.)
            "version": day_cov["version"],        # the day-covering version (None when crossing) —
                                                   # fixes the "wrong fingerprint persisted" MAJOR
                                                   # finding (was rule_versions_by_id[rule_id][-1]).
            "last_observed_at": None, "eni_ids": set(),
        }
        if day_cov["crossing"]:
            any_crossing = True

    # Hoisted once per call (not per flow/rule): eni_id -> {group_ids, private_ips, vpc_id}.
    eni_index = {}
    for vpc_id, snap in memberships_by_vpc.items():
        for m in snap:
            eni_id = m.get("eni_id")
            if not eni_id:
                continue
            eni_index[eni_id] = {
                "group_ids": set(m.get("group_ids") or []),
                "private_ips": set(m.get("private_ips") or []),
                "vpc_id": vpc_id,
            }

    def sg_resolver_factory(vpc_id):
        snap = memberships_by_vpc.get(vpc_id)
        if snap is None:
            return None

        def _resolve(group_id):
            gids_ips = set()
            for m in snap:
                if group_id in (m.get("group_ids") or []):
                    gids_ips.update(m.get("private_ips") or [])
            return gids_ips
        return _resolve

    for flow in flows:
        interface_id = flow.get("interface_id")
        dst = flow.get("dstaddr")
        src = flow.get("srcaddr")
        port = int(flow["dstport"]) if flow.get("dstport") not in (None, "") else None
        proto = flow.get("protocol")
        bytes_ = int(flow.get("bytes") or 0)
        cnt = int(flow.get("cnt") or 1)
        last_start = None
        if flow.get("last_start") not in (None, ""):
            try:
                last_start = dt.datetime.fromtimestamp(int(flow["last_start"]), tz=dt.timezone.utc)
            except (TypeError, ValueError):
                last_start = None
        if not dst or not src or not interface_id:
            continue
        eni = eni_index.get(interface_id)
        if eni is None or not eni["group_ids"]:
            # This flow's own ENI membership cannot be resolved (no snapshot covers it, or it
            # carries no SGs) — never fabricate membership; the flow contributes no evidence.
            continue
        if src in eni["private_ips"]:
            direction, peer_ip = "egress", dst
        elif dst in eni["private_ips"]:
            direction, peer_ip = "ingress", src
        else:
            # Neither tuple endpoint matches this ENI's own known private IPs (stale/incomplete
            # membership snapshot, secondary IP not captured, NAT/ELB-rewritten flow, ...) —
            # direction and local/peer orientation cannot be safely inferred; skip rather than guess.
            continue
        vpc_id = eni["vpc_id"]
        resolver = sg_resolver_factory(vpc_id)

        for rule_id in rule_versions_by_id:
            cov = per_rule[rule_id]
            if cov["unassessable"]:
                continue
            version = cov["version"]
            if version is None:
                continue
            # ENI -> SG membership check (the CRITICAL fix): only a rule whose group_id this flow's
            # OWN ENI actually carries can be credited with this flow's traffic.
            if version["group_id"] not in eni["group_ids"]:
                continue
            rule = {"protocol": version["protocol"], "from_port": version.get("from_port"),
                    "to_port": version.get("to_port"), "peer_kind": version["peer_kind"],
                    "peer_value": version["peer_value"], "is_egress": version["is_egress"],
                    "group_id": version["group_id"]}
            outcome = sm.match_flow_against_rule(
                rule, {"peer_ip": peer_ip, "port": port, "protocol": proto, "direction": direction},
                sg_peer_ip_resolver=resolver, prefix_list_resolver=None)
            if outcome == sm.MatchOutcome.MATCH:
                cov["compatible"] += cnt
                cov["bytes"] += bytes_
                cov["eni_ids"].add(interface_id)
                if last_start and (cov["last_observed_at"] is None or last_start > cov["last_observed_at"]):
                    cov["last_observed_at"] = last_start
            elif outcome == sm.MatchOutcome.UNASSESSABLE:
                # MAJOR fix: UNASSESSABLE (prefix-list peer, ICMP, unresolvable SG reference) must
                # never be silently discarded — it downgrades this rule/day to `unassessable` unless
                # a confident MATCH is also found (classify_rule_day already gives MATCH priority).
                cov["match_unassessable"] = True

    conn.run("BEGIN")
    try:
        conn.run(
            "DELETE FROM sg_rule_activity_daily WHERE account_id=:a AND region=:r AND observed_on=:d",
            a=account_id, r=region, d=day_str)
        for rule_id, cov in per_rule.items():
            if cov["version"] is not None:
                fp = cov["version"]["fingerprint"]
            elif rule_versions_by_id[rule_id]:
                # Epoch-crossing day: no single version covers the whole day. Fall back to the
                # latest known version's fingerprint purely as a display reference — the `coverage`
                # JSON's `fingerprint_epoch_crossing: true` is the authoritative signal that this
                # fingerprint must NOT be trusted as "the" shape for this day.
                fp = rule_versions_by_id[rule_id][-1]["fingerprint"]
            else:
                fp = ""
            final_unassessable = cov["unassessable"] or cov["match_unassessable"]
            status = sm.classify_rule_day(cov["compatible"], cov["overlap"], True, final_unassessable)
            coverage = {
                "unassessable": final_unassessable,
                "fingerprint_epoch_crossing": cov["unassessable"],
                "match_unassessable": cov["match_unassessable"],
                "status": status,
            }
            conn.run(
                "INSERT INTO sg_rule_activity_daily "
                "(account_id, region, rule_id, rule_fingerprint, observed_on, compatible_match_count, "
                " compatible_bytes, overlap_match_count, unique_eni_count, last_observed_at, coverage) "
                "VALUES (:a,:r,:rid,:fp,:d,:cm,:cb,:om,:ue,:lo,:cov::jsonb)",
                a=account_id, r=region, rid=rule_id, fp=fp, d=day_str, cm=cov["compatible"],
                cb=cov["bytes"], om=cov["overlap"], ue=len(cov["eni_ids"]), lo=cov["last_observed_at"],
                cov=json.dumps(coverage),
            )
        conn.run(
            "INSERT INTO sg_rule_scan_runs "
            "(id, flow_source_id, status, partition_start, partition_end, rows_processed, coverage, started_at, finished_at) "
            "VALUES (:id,:fid,'succeeded',:ps,:pe,:rows,:cov::jsonb,now(),now())",
            id=run_id, fid=source["id"], ps=start, pe=end, rows=len(flows),
            cov=json.dumps({"fingerprint_epoch_crossing_any": any_crossing}),
        )
        conn.run("COMMIT")
    except Exception:
        conn.run("ROLLBACK")
        raise
    return {"run_id": run_id, "day": day_str, "rule_count": len(per_rule), "any_crossing": any_crossing}


# ── Load rule-version rows + ENI-membership snapshots for matching ───────────────────────────────

def load_rule_versions(conn, account_id, region):
    """rule_id -> list of version dicts (valid_from/valid_to/shape fields), matching source of
    truth per the spec (never the mutable sg_rule_inventory cache)."""
    rows = conn.run(
        "SELECT rule_id, fingerprint, group_id, is_egress, protocol, from_port, to_port, "
        "peer_kind, peer_value, valid_from, valid_to FROM sg_rule_inventory_versions "
        "WHERE account_id=:a AND region=:r ORDER BY rule_id, valid_from",
        a=account_id, r=region)
    out = {}
    for r in rows:
        d = {"rule_id": r[0], "fingerprint": r[1], "group_id": r[2], "is_egress": r[3],
             "protocol": r[4], "from_port": r[5], "to_port": r[6], "peer_kind": r[7],
             "peer_value": r[8], "valid_from": r[9], "valid_to": r[10]}
        out.setdefault(r[0], []).append(d)
    return out


def load_membership_by_vpc(conn, account_id, region, day, staleness_days):
    """One resolved snapshot (list of {eni_id, group_ids, private_ips}) per vpc_id, using
    nearest-prior-in-time / pre-snapshotting-backfill resolution (sg_rule_matching.resolve_membership_snapshot)."""
    rows = conn.run(
        "SELECT vpc_id, observed_at, eni_id, group_ids, private_ips FROM sg_eni_membership_snapshots "
        "WHERE account_id=:a AND region=:r", a=account_id, r=region)
    by_vpc = {}
    for r in rows:
        by_vpc.setdefault(r[0], []).append({
            "observed_at": r[1], "eni_id": r[2],
            "group_ids": r[3] if isinstance(r[3], list) else json.loads(r[3] or "[]"),
            "private_ips": r[4] if isinstance(r[4], list) else json.loads(r[4] or "[]"),
        })
    resolved = {}
    for vpc_id, snaps in by_vpc.items():
        by_time = {}
        for s in snaps:
            by_time.setdefault(s["observed_at"], []).append(s)
        snapshot_rows = [{"observed_at": t} for t in by_time]
        chosen, _outcome = sm.resolve_membership_snapshot(snapshot_rows, day, staleness_days)
        if chosen is not None:
            resolved[vpc_id] = by_time[chosen["observed_at"]]
    return resolved


def _write_failed_run(conn, source, day, reason, error_code):
    """Write a terminal `failed` sg_rule_scan_runs row (MAJOR "failure invisibility" fix) — so the
    reaper's stale-run reconciliation and any downstream API/UI caller see a real failed row
    instead of silence (previously only an in-memory list entry that run()'s top-level
    `{"status": "ok"}` return discarded)."""
    start, end = sm.day_bounds_utc(day)
    conn.run(
        "INSERT INTO sg_rule_scan_runs "
        "(id, flow_source_id, status, partition_start, partition_end, rows_processed, coverage, "
        " error_code, started_at, finished_at) "
        "VALUES (:id,:fid,'failed',:ps,:pe,0,:cov::jsonb,:ec,now(),now())",
        id=str(uuid.uuid4()), fid=source["id"], ps=start, pe=end,
        cov=json.dumps({"reason": str(reason or "")[:2000]}), ec=error_code,
    )


def run(payload, conn, ec2_client_factory=None, lambda_client_factory=None):
    """Top-level entry point for handlers.py's `sg_rule_scan` handler.

    `ec2_client_factory(account_id, region, external_id) -> boto3 ec2 client` and
    `lambda_client_factory() -> boto3 lambda client` are injectable for testing; production
    defaults use readonly_ec2_client (Role A) and a plain boto3 lambda client respectively.
    """
    account_id = payload["account_id"]
    region = payload["region"]
    source = load_source(conn, account_id, region)
    ext_id = account_external_id(conn, account_id)

    ec2 = (ec2_client_factory or readonly_ec2_client)(account_id, region, ext_id)
    now = dt.datetime.now(dt.timezone.utc)
    rules = snapshot_rules_via_describe(ec2)
    memberships = snapshot_eni_membership_via_describe(ec2)
    upsert_inventory_and_versions(conn, account_id, region, rules, now)
    write_eni_snapshot(conn, account_id, region, memberships, now)

    broker_arn = os.environ.get("SG_RULE_ATHENA_BROKER_ARN")
    if not broker_arn:
        return {"status": "inventory_only", "reason": "SG_RULE_ATHENA_BROKER_ARN not set (feature flag off)"}
    lam = (lambda_client_factory or (lambda: boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))))()

    fid = source["id"]
    watermark = last_committed_day(conn, fid)
    source_created_day = source["created_at"].date() if hasattr(source["created_at"], "date") else source["created_at"]
    next_day = sm.next_day_to_process(watermark, source_created_day)

    days_to_run = []
    if sm.is_day_eligible(next_day, now, DELIVERY_LAG_HOURS):
        days_to_run.append(next_day)
    days_to_run.extend(sm.rescan_window_days(watermark, RESCAN_WINDOW_DAYS))

    rule_versions = load_rule_versions(conn, account_id, region)
    results = []
    for day in days_to_run:
        if not sm.is_day_eligible(day, now, DELIVERY_LAG_HOURS):
            continue
        body = invoke_broker_query(lam, broker_arn, account_id, region, ext_id, source, day)
        if not body.get("ok"):
            # MAJOR fix ("failure invisibility"): a failed Athena day must not be invisible to the
            # reaper/API/UI — write a terminal `failed` sg_rule_scan_runs row, not just an in-memory
            # note that the top-level `run()` result silently drops on the floor.
            _write_failed_run(conn, source, day, body.get("reason"), "athena_query_failed")
            results.append({"day": day.isoformat(), "status": "failed", "reason": body.get("reason")})
            continue
        memberships_by_vpc = load_membership_by_vpc(conn, account_id, region, day, MEMBERSHIP_STALENESS_DAYS)
        try:
            res = process_day(conn, source, day, body.get("rows", []), rule_versions, memberships_by_vpc, None)
        except Exception as e:  # noqa: BLE001 — one day's transaction failure must not crash run()
            # process_day() itself still raises on internal failure (its own rollback contract is
            # unchanged, see test_process_day_rolls_back_on_failure) — this is the caller-side
            # translation into a visible, terminal run row for THIS day, so other days keep going.
            _write_failed_run(conn, source, day, str(e), "process_day_failed")
            results.append({"day": day.isoformat(), "status": "failed", "reason": str(e)})
            continue
        results.append(res)
    return {"status": "ok", "days": results}
