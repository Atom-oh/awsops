"""SG Rules & Usage — pure matching engine (no DB/boto3 imports; unit-tested in isolation).

Implements the design spec's "Match model" + "Why versioning" sections:
docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md

Everything here is a pure function over already-fetched inputs (rule dicts, flow-log rows,
membership snapshots, rule-version rows) — no AWS/DB calls. sg_rule_scan.py wires this to Aurora
+ the Athena broker; this module is what the "Matching" test list in the spec's Testing section
targets directly.
"""
import hashlib
import ipaddress
import json
from datetime import datetime, timedelta, timezone

PROTO_NAME = {"6": "tcp", "17": "udp", "1": "icmp", "58": "icmpv6"}


# ── Rule fingerprint (sg_rule_inventory_versions) ────────────────────────────────────────────────

def rule_fingerprint(rule: dict) -> str:
    """Stable hash of the fields that define a rule's SHAPE (not its identity/timestamps). Two
    snapshots of the same rule_id with identical shape must hash identically so a same-shape
    re-snapshot never spuriously opens a new version row."""
    shape = {
        "group_id": rule["group_id"], "is_egress": bool(rule["is_egress"]),
        "protocol": rule["protocol"], "from_port": rule.get("from_port"),
        "to_port": rule.get("to_port"), "peer_kind": rule["peer_kind"],
        "peer_value": rule["peer_value"],
    }
    blob = json.dumps(shape, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ── Day-granularity fingerprint-epoch-crossing check ─────────────────────────────────────────────

def day_bounds_utc(day) -> tuple:
    """`day` a date -> (start_of_day, end_of_day) as timezone-aware UTC datetimes, end EXCLUSIVE."""
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return start, start + timedelta(days=1)


def version_covering(versions: list, at: datetime):
    """The single sg_rule_inventory_versions row whose [valid_from, valid_to) covers instant `at`,
    or None. `versions` is a list of dicts with valid_from/valid_to (valid_to may be None = open)."""
    for v in versions:
        vf = v["valid_from"]
        vt = v.get("valid_to")
        if vf <= at and (vt is None or at < vt):
            return v
    return None


def day_coverage(versions: list, day) -> dict:
    """Per the spec's "Why versioning" section: a day matches confidently only if ONE version's
    [valid_from, valid_to) covers the WHOLE day (start-of-day AND end-of-day resolve to the same
    version row, by identity — not just equal fingerprint, since valid_from/valid_to distinguish
    epochs even when a rule flips back to an identical shape). If they differ (or either boundary
    resolves to no version at all), the day is `fingerprint_epoch_crossing` and MUST be classified
    `unassessable` for that rule/day — never a lower-bound number (spec's own round-12 self-check).
    Returns {"crossing": bool, "version": dict|None} — version is set only when NOT crossing.
    """
    start, end = day_bounds_utc(day)
    at_start = version_covering(versions, start)
    # end is exclusive; check the instant just before day-end (end - epsilon), i.e. "at or before
    # end of day" — using `end` minus a microsecond avoids falsely picking up a version whose
    # valid_from == end (a version starting exactly at midnight belongs to the NEXT day only).
    at_end = version_covering(versions, end - timedelta(microseconds=1))
    if at_start is None or at_end is None:
        return {"crossing": True, "version": None}
    same = (at_start.get("valid_from") == at_end.get("valid_from"))
    if not same:
        return {"crossing": True, "version": None}
    return {"crossing": False, "version": at_start}


# ── ENI/SG membership resolution (nearest-prior-in-time, staleness-bounded) ──────────────────────

def resolve_membership_snapshot(snapshots: list, day, staleness_days: int, earliest_snapshot_at=None):
    """`snapshots` sorted or unsorted list of dicts with `observed_at` (datetime), for one
    account/region/vpc. Returns (snapshot_or_None, outcome) where outcome is one of:
      - "in_window": nearest-prior-or-equal-to end-of-day snapshot found within staleness_days
      - "stale": a prior snapshot exists but it's older than staleness_days relative to this day
      - "pre_snapshotting_backfill": day is older than the EARLIEST snapshot this source ever took
        -> pinned to that earliest snapshot (fixed reference, not "whatever's current now" — see
        the spec's "Initial historical backfill" section for why this must never float).
      - "no_snapshot": no snapshot exists at all (source never snapshotted, or wrong vpc)
    """
    if not snapshots:
        return None, "no_snapshot"
    _, day_end = day_bounds_utc(day)
    ordered = sorted(snapshots, key=lambda s: s["observed_at"])
    earliest = ordered[0]
    earliest_at = earliest_snapshot_at or earliest["observed_at"]
    if day_end <= earliest_at:
        # Day predates (or is exactly at) the earliest snapshot ever taken for this source — pin to
        # that fixed earliest snapshot, regardless of what other snapshots exist "now".
        return earliest, "pre_snapshotting_backfill"
    # Nearest snapshot at-or-before end of day.
    candidates = [s for s in ordered if s["observed_at"] <= day_end]
    if not candidates:
        return None, "no_snapshot"
    nearest = max(candidates, key=lambda s: s["observed_at"])
    age_days = (day_end - nearest["observed_at"]).total_seconds() / 86400.0
    if age_days <= staleness_days:
        return nearest, "in_window"
    return nearest, "stale"


# ── Peer / CIDR / SG-reference / prefix-list matching ────────────────────────────────────────────

def _is_v6(addr: str) -> bool:
    return ":" in addr


def ip_in_cidr(addr: str, cidr: str) -> bool:
    try:
        return ipaddress.ip_address(addr) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


def eni_matches_vpc_scope(target_vpc_id: str, eni_vpc_id: str, peered_or_shared_vpc_ids: set) -> bool:
    """SG-reference resolution must scope to the flow's own VPC plus any VPC known to be able to
    legally reference it (peering / RAM shared-VPC participant) — never "any VPC" (RFC1918 overlap
    would let an unrelated VPC's ENI match by coincidence) and never "same VPC only" (that produces
    a false no_observed_evidence for legitimately cross-VPC-referenced rules)."""
    return eni_vpc_id == target_vpc_id or eni_vpc_id in peered_or_shared_vpc_ids


def resolve_sg_peer_ips(snapshot: dict, group_id: str) -> set:
    """IPs of ENIs in `snapshot` (one point-in-time membership row's aggregate — callers pass the
    resolved snapshot for the relevant vpc) that carry `group_id`. `snapshot` shape:
    {"eni_id":..., "group_ids": [...], "private_ips": [...]}. Callers typically pass a LIST of
    such rows for one observed_at and reduce; this helper handles one row."""
    if group_id in (snapshot.get("group_ids") or []):
        return set(snapshot.get("private_ips") or [])
    return set()


class MatchOutcome:
    MATCH = "match"
    NO_MATCH = "no_match"
    UNASSESSABLE = "unassessable"  # structurally cannot be decided (pl, IPv6-unsupported, etc.)


def match_protocol_port(rule: dict, flow_protocol: str, flow_port) -> bool:
    if rule["protocol"] != "all":
        proto_name = PROTO_NAME.get(str(flow_protocol), str(flow_protocol))
        if proto_name != rule["protocol"]:
            return False
    from_port = rule.get("from_port")
    to_port = rule.get("to_port")
    if from_port is not None and from_port != -1:
        if flow_port is None:
            return False
        if flow_port < from_port or flow_port > (to_port if to_port is not None else from_port):
            return False
    return True


def match_peer(rule: dict, peer_ip: str, sg_peer_ip_resolver=None, prefix_list_resolver=None) -> str:
    """Returns a MatchOutcome. `sg_peer_ip_resolver(group_id) -> set[str] | None` (None = SG not
    resolvable this window -> unassessable, per ruleMatchable's precedent in sg-analysis.ts).
    `prefix_list_resolver(pl_id) -> set[str] | None` (entries as CIDRs; None = not resolvable)."""
    kind = rule["peer_kind"]
    if kind == "cidr":
        if _is_v6(rule["peer_value"]) != _is_v6(peer_ip):
            return MatchOutcome.NO_MATCH
        if rule["peer_value"] in ("0.0.0.0/0", "::/0"):
            return MatchOutcome.MATCH
        return MatchOutcome.MATCH if ip_in_cidr(peer_ip, rule["peer_value"]) else MatchOutcome.NO_MATCH
    if kind == "sg":
        if sg_peer_ip_resolver is None:
            return MatchOutcome.UNASSESSABLE
        ips = sg_peer_ip_resolver(rule["peer_value"])
        if ips is None:
            return MatchOutcome.UNASSESSABLE
        return MatchOutcome.MATCH if peer_ip in ips else MatchOutcome.NO_MATCH
    if kind == "pl":
        if prefix_list_resolver is None:
            return MatchOutcome.UNASSESSABLE
        entries = prefix_list_resolver(rule["peer_value"])
        if entries is None:
            return MatchOutcome.UNASSESSABLE
        return MatchOutcome.MATCH if any(ip_in_cidr(peer_ip, e) for e in entries) else MatchOutcome.NO_MATCH
    return MatchOutcome.UNASSESSABLE


def match_flow_against_rule(rule: dict, flow: dict, sg_peer_ip_resolver=None, prefix_list_resolver=None) -> str:
    """Single flow-tuple vs one candidate rule -> MatchOutcome. `flow` shape:
    {"peer_ip":..., "port":..., "protocol":..., "direction": "ingress"|"egress"|None}.
    ICMP/ICMPv6 rules are structurally unassessable (from_port/to_port are type/code, not a port
    range — comparing against a Flow Log dstport is meaningless, mirrors sg-analysis.ts)."""
    if rule["protocol"] in ("icmp", "icmpv6"):
        return MatchOutcome.UNASSESSABLE
    if flow.get("direction") is not None:
        want_egress = flow["direction"] == "egress"
        if want_egress != bool(rule["is_egress"]):
            return MatchOutcome.NO_MATCH
    if not match_protocol_port(rule, flow.get("protocol"), flow.get("port")):
        return MatchOutcome.NO_MATCH
    return match_peer(rule, flow["peer_ip"], sg_peer_ip_resolver, prefix_list_resolver)


def classify_rule_day(compatible_count: int, overlap_count: int, has_source: bool, unassessable: bool) -> str:
    """Roll one rule/day's counters into the spec's 5-way classification."""
    if not has_source:
        return "not_configured"
    if unassessable and compatible_count == 0:
        return "unassessable"
    if overlap_count > 0:
        return "overlapping"
    if compatible_count > 0:
        return "observed_compatible"
    return "no_observed_evidence"


# ── Daily pipeline pure helpers (delivery lag, watermark, rescan window) ─────────────────────────

def is_day_eligible(day, now_utc: datetime, delivery_lag_hours: int) -> bool:
    """A day becomes eligible only once it clears the delivery-lag grace period AFTER its own end
    (the day whose data might still be arriving must not be scanned as if complete)."""
    _, day_end = day_bounds_utc(day)
    return now_utc >= day_end + timedelta(hours=delivery_lag_hours)


def next_day_to_process(last_committed_day, source_created_day):
    """`last_committed_day` (date|None) -> the day after it, or source_created_day if nothing has
    been committed yet (first run, initial-historical-backfill start point)."""
    if last_committed_day is None:
        return source_created_day
    return last_committed_day + timedelta(days=1)


def rescan_window_days(last_committed_day, window_days: int) -> list:
    """The trailing N already-committed days to re-scan (idempotent re-run, never touches the
    watermark). Returns dates in ascending order; empty if nothing has been committed yet."""
    if last_committed_day is None or window_days <= 0:
        return []
    return [last_committed_day - timedelta(days=i) for i in range(window_days - 1, -1, -1)]
