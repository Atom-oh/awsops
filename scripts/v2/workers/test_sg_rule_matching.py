"""Pure matching-engine tests for the SG Rules & Usage design spec's "Matching" test list
(docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md)."""
from datetime import date, datetime, timedelta, timezone

import pytest

import sg_rule_matching as m


def utc(y, mo, d, h=0, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


# ── fingerprint ───────────────────────────────────────────────────────────────────────────────

def test_fingerprint_stable_for_identical_shape():
    r1 = {"group_id": "sg-1", "is_egress": False, "protocol": "tcp", "from_port": 443,
          "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"}
    r2 = dict(r1)
    assert m.rule_fingerprint(r1) == m.rule_fingerprint(r2)


def test_fingerprint_changes_on_shape_change():
    r1 = {"group_id": "sg-1", "is_egress": False, "protocol": "tcp", "from_port": 443,
          "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"}
    r2 = {**r1, "to_port": 8443}
    assert m.rule_fingerprint(r1) != m.rule_fingerprint(r2)


# ── day-boundary fingerprint-epoch-crossing ──────────────────────────────────────────────────────

def test_day_confidently_matched_when_one_version_covers_whole_day():
    versions = [{"valid_from": utc(2026, 1, 1), "valid_to": None}]
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is False
    assert cov["version"]["valid_from"] == utc(2026, 1, 1)


def test_day_crossing_when_version_changes_mid_day_never_a_lower_bound():
    versions = [
        {"valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 5, 14, 0)},
        {"valid_from": utc(2026, 3, 5, 14, 0), "valid_to": None},
    ]
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is True
    assert cov["version"] is None


def test_day_not_crossing_when_transition_is_on_an_adjacent_day():
    versions = [
        {"valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 6, 0, 0)},
        {"valid_from": utc(2026, 3, 6, 0, 0), "valid_to": None},
    ]
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is False


def test_day_crossing_when_no_version_covers_a_boundary():
    versions = [{"valid_from": utc(2026, 3, 6), "valid_to": None}]  # starts AFTER the day in question
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is True
    assert cov["version"] is None


def test_classify_rule_day_crossing_downgrades_to_unassessable_not_lower_bound():
    status = m.classify_rule_day(compatible_count=0, overlap_count=0, has_source=True, unassessable=True)
    assert status == "unassessable"
    # Never rendered as e.g. "at least N" — the classification itself has no numeric lower bound field.


# ── ENI-membership snapshot staleness three-way split ────────────────────────────────────────────

def test_membership_in_window():
    snaps = [{"observed_at": utc(2026, 3, 3)}, {"observed_at": utc(2026, 3, 7)}]  # 3/7 is AFTER day end
    snap, outcome = m.resolve_membership_snapshot(snaps, date(2026, 3, 5), staleness_days=3)
    assert outcome == "in_window"
    assert snap["observed_at"] == utc(2026, 3, 3)


def test_membership_stale_beyond_staleness_days():
    snaps = [{"observed_at": utc(2026, 1, 1)}]
    snap, outcome = m.resolve_membership_snapshot(snaps, date(2026, 3, 5), staleness_days=3)
    assert outcome == "stale"


def test_membership_pre_snapshotting_backfill_pins_to_earliest():
    snaps = [{"observed_at": utc(2026, 6, 1)}, {"observed_at": utc(2026, 7, 1)}]
    snap, outcome = m.resolve_membership_snapshot(snaps, date(2026, 1, 1), staleness_days=3)
    assert outcome == "pre_snapshotting_backfill"
    assert snap["observed_at"] == utc(2026, 6, 1)  # earliest, not latest


def test_membership_no_snapshot_at_all():
    snap, outcome = m.resolve_membership_snapshot([], date(2026, 1, 1), staleness_days=3)
    assert outcome == "no_snapshot"
    assert snap is None


def test_reprocessing_pre_snapshotting_day_is_idempotent_even_with_a_newer_snapshot_added_later():
    """The idempotent-retry regression test: pinning to the EARLIEST snapshot (not "current") means
    reprocessing the same historical day produces the same result even after a new snapshot appears."""
    first_run_snaps = [{"observed_at": utc(2026, 6, 1)}]
    snap1, outcome1 = m.resolve_membership_snapshot(first_run_snaps, date(2026, 1, 1), staleness_days=3)

    later_snaps = first_run_snaps + [{"observed_at": utc(2026, 8, 1)}]  # a newer snapshot appeared
    snap2, outcome2 = m.resolve_membership_snapshot(later_snaps, date(2026, 1, 1), staleness_days=3)

    assert outcome1 == outcome2 == "pre_snapshotting_backfill"
    assert snap1["observed_at"] == snap2["observed_at"] == utc(2026, 6, 1)


def test_membership_pins_to_explicit_earliest_snapshot_at_when_given():
    """Callers may pass the source's durably-recorded earliest_snapshot_at directly (not derived
    from whatever snapshot rows happen to be in the passed-in list) — this must still win."""
    snaps = [{"observed_at": utc(2026, 6, 1)}]
    snap, outcome = m.resolve_membership_snapshot(
        snaps, date(2026, 1, 1), staleness_days=3, earliest_snapshot_at=utc(2026, 6, 1))
    assert outcome == "pre_snapshotting_backfill"


# ── CIDR / IPv6 / SG-reference / prefix-list / protocol / port-range matching ────────────────────

def test_cidr_v4_match():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "10.0.0.0/8", "is_egress": False}
    flow = {"peer_ip": "10.1.2.3", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.MATCH


def test_cidr_v4_no_match_outside_range():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "10.0.0.0/8", "is_egress": False}
    flow = {"peer_ip": "192.168.1.1", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.NO_MATCH


def test_ipv6_internet_match():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "::/0", "is_egress": False}
    flow = {"peer_ip": "2001:db8::1", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.MATCH


def test_ipv6_family_mismatch_no_match():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "::/0", "is_egress": False}
    flow = {"peer_ip": "10.0.0.1", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.NO_MATCH


def test_sg_reference_match_via_resolver():
    rule = {"protocol": "tcp", "from_port": 22, "to_port": 22, "peer_kind": "sg",
            "peer_value": "sg-peer", "is_egress": False}
    flow = {"peer_ip": "10.5.5.5", "port": 22, "protocol": "6", "direction": "ingress"}
    resolver = lambda gid: {"10.5.5.5"} if gid == "sg-peer" else set()
    assert m.match_flow_against_rule(rule, flow, sg_peer_ip_resolver=resolver) == m.MatchOutcome.MATCH


def test_sg_reference_unassessable_when_resolver_returns_none():
    rule = {"protocol": "tcp", "from_port": 22, "to_port": 22, "peer_kind": "sg",
            "peer_value": "sg-peer", "is_egress": False}
    flow = {"peer_ip": "10.5.5.5", "port": 22, "protocol": "6", "direction": "ingress"}
    resolver = lambda gid: None  # not resolvable this window (e.g. outside VPC scope / no snapshot)
    assert m.match_flow_against_rule(rule, flow, sg_peer_ip_resolver=resolver) == m.MatchOutcome.UNASSESSABLE


def test_sg_reference_unassessable_when_no_resolver_given():
    rule = {"protocol": "tcp", "from_port": 22, "to_port": 22, "peer_kind": "sg",
            "peer_value": "sg-peer", "is_egress": False}
    flow = {"peer_ip": "10.5.5.5", "port": 22, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.UNASSESSABLE


def test_prefix_list_match_via_resolver():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "pl",
            "peer_value": "pl-1", "is_egress": False}
    flow = {"peer_ip": "203.0.113.5", "port": 443, "protocol": "6", "direction": "ingress"}
    resolver = lambda pl: ["203.0.113.0/24"] if pl == "pl-1" else None
    assert m.match_flow_against_rule(rule, flow, prefix_list_resolver=resolver) == m.MatchOutcome.MATCH


def test_prefix_list_unassessable_when_not_resolvable():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "pl",
            "peer_value": "pl-1", "is_egress": False}
    flow = {"peer_ip": "203.0.113.5", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.UNASSESSABLE


def test_icmp_is_structurally_unassessable():
    rule = {"protocol": "icmp", "from_port": 8, "to_port": 0, "peer_kind": "cidr",
            "peer_value": "0.0.0.0/0", "is_egress": False}
    flow = {"peer_ip": "1.2.3.4", "port": 0, "protocol": "1", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.UNASSESSABLE


def test_protocol_mismatch_no_match():
    rule = {"protocol": "udp", "from_port": 53, "to_port": 53, "peer_kind": "cidr",
            "peer_value": "0.0.0.0/0", "is_egress": False}
    flow = {"peer_ip": "1.2.3.4", "port": 53, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.NO_MATCH


def test_port_range_match():
    rule = {"protocol": "tcp", "from_port": 1024, "to_port": 2048, "peer_kind": "cidr",
            "peer_value": "0.0.0.0/0", "is_egress": False}
    flow = {"peer_ip": "1.2.3.4", "port": 1500, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.MATCH


def test_all_protocol_all_ports_rule_matches_anything():
    rule = {"protocol": "all", "from_port": None, "to_port": None, "peer_kind": "cidr",
            "peer_value": "0.0.0.0/0", "is_egress": False}
    flow = {"peer_ip": "1.2.3.4", "port": 9999, "protocol": "17", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.MATCH


def test_ingress_egress_direction_gating():
    egress_rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
                   "peer_value": "0.0.0.0/0", "is_egress": True}
    ingress_flow = {"peer_ip": "1.2.3.4", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(egress_rule, ingress_flow) == m.MatchOutcome.NO_MATCH


def test_eni_matches_vpc_scope_same_vpc():
    assert m.eni_matches_vpc_scope("vpc-1", "vpc-1", set())


def test_eni_matches_vpc_scope_peered_vpc():
    assert m.eni_matches_vpc_scope("vpc-1", "vpc-2", {"vpc-2"})


def test_eni_matches_vpc_scope_unrelated_vpc_rejected():
    assert not m.eni_matches_vpc_scope("vpc-1", "vpc-9", {"vpc-2"})


# ── classification roll-up ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("compatible,overlap,has_source,unassessable,expected", [
    (0, 0, False, False, "not_configured"),
    (0, 0, True, True, "unassessable"),
    (0, 0, True, False, "no_observed_evidence"),
    (3, 0, True, False, "observed_compatible"),
    (3, 2, True, False, "overlapping"),
    (3, 0, True, True, "observed_compatible"),  # positive evidence wins over an unassessable flag elsewhere
])
def test_classify_rule_day(compatible, overlap, has_source, unassessable, expected):
    assert m.classify_rule_day(compatible, overlap, has_source, unassessable) == expected


# ── daily pipeline pure helpers ───────────────────────────────────────────────────────────────

def test_delivery_lag_grace_period_honored():
    day = date(2026, 3, 5)
    # exactly at day end + 5h < 6h lag -> not yet eligible
    assert not m.is_day_eligible(day, utc(2026, 3, 6, 5, 0), delivery_lag_hours=6)
    # at day end + 6h -> eligible
    assert m.is_day_eligible(day, utc(2026, 3, 6, 6, 0), delivery_lag_hours=6)


def test_next_day_to_process_from_watermark():
    assert m.next_day_to_process(date(2026, 3, 5), date(2026, 1, 1)) == date(2026, 3, 6)


def test_next_day_to_process_first_run_uses_source_created_day():
    assert m.next_day_to_process(None, date(2026, 1, 1)) == date(2026, 1, 1)


def test_rescan_window_days_trailing_and_ascending():
    days = m.rescan_window_days(date(2026, 3, 5), window_days=2)
    assert days == [date(2026, 3, 4), date(2026, 3, 5)]


def test_rescan_window_never_moves_watermark_itself():
    """rescan_window_days is read-only advice for a re-run — the watermark (last_committed_day) is
    a caller-owned value this function never mutates or returns a "new" version of."""
    watermark = date(2026, 3, 5)
    _ = m.rescan_window_days(watermark, window_days=2)
    assert watermark == date(2026, 3, 5)  # untouched


def test_rescan_window_empty_before_first_commit():
    assert m.rescan_window_days(None, window_days=2) == []
