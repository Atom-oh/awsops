from finops import guards


def test_protected_tag_hit_case_insensitive_key_and_value():
    assert guards.protected_tag({"DR": "true"}) == "protected_tag:DR"
    assert guards.protected_tag({"Compliance": "yes"}) == "protected_tag:Compliance"


def test_protected_tag_no_hit_on_falsy_value():
    assert guards.protected_tag({"dr": "false"}) is None
    assert guards.protected_tag({"dr": "0"}) is None
    assert guards.protected_tag({"dr": ""}) is None


def test_protected_tag_no_hit_on_unrelated_tags_or_none():
    assert guards.protected_tag({"Name": "web-1"}) is None
    assert guards.protected_tag(None) is None
    assert guards.protected_tag({}) is None


def test_insufficient_observation_hit_only_on_that_exact_reason():
    assert guards.insufficient_observation("INSUFFICIENT_DATA") == "insufficient_observation_period"
    assert guards.insufficient_observation("OVER_PROVISIONED") is None
    assert guards.insufficient_observation(None) is None


def test_stale_row_data_hit_only_when_true():
    assert guards.stale_row_data(True) == "stale_inventory_data"
    assert guards.stale_row_data(False) is None


def test_guard_hits_aggregates_all_firing_guards():
    hits = guards.guard_hits(tags={"dr": "true"}, finding_reason="INSUFFICIENT_DATA", stale=True)
    assert hits == ["protected_tag:dr", "insufficient_observation_period", "stale_inventory_data"]


def test_guard_hits_empty_when_nothing_fires():
    assert guards.guard_hits(tags={"Name": "x"}, finding_reason="OVER_PROVISIONED", stale=False) == []


def test_guard_hits_defaults_stale_to_false():
    assert guards.guard_hits(tags=None, finding_reason=None) == []
