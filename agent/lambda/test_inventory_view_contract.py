"""The sql_reader views and the inventory-read connector are one contract — pin it.

A previous revision removed `data`/`meta` from the views to close a JSONB fail-open hole and broke
`find_unused_resources`, `query_inventory` and `get_topology` at runtime: the connector selects those
columns, the reader role resolves the unqualified table name to the view, and Postgres answered
"column data does not exist". Nothing caught it, because the connector's unit tests mock `_execute`
and so never exercise the view/role contract at all (PR #197 review CRITICAL).

A real end-to-end check needs a live cluster and the reader role, which CI does not have. What CI can
do is refuse the drift that caused the outage: every key the connector projects must be exposed by
the view, and the row-copy key must never be. These assertions read the migration text, so they fail
on either side of the contract moving.
"""
import os
import re
import unittest

import inventory_read_mcp as inv

MIGRATION = os.path.join(
    os.path.dirname(__file__), "..", "..", "terraform", "v2", "foundation", "migrations",
    "01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql")


def _view_columns(table):
    """The column-list literal the migration builds this view from."""
    src = open(MIGRATION, encoding="utf-8").read()
    m = re.search(r"\('" + re.escape(table) + r"',\s*(.*?)\),\s*$", src, re.S | re.M)
    assert m, "no view definition for " + table
    return m.group(1)


def _allowlisted_keys(table):
    """Keys named in the view's jsonb_object_agg ... k = ANY(ARRAY[...]) projection."""
    cols = _view_columns(table)
    m = re.search(r"k = ANY\(ARRAY\[(.*?)\]\)", cols, re.S)
    if not m:
        return set()
    return set(re.findall(r"'([^']+)'", m.group(1)))


class TestInventoryViewContract(unittest.TestCase):
    def test_every_projected_key_is_exposed_by_the_view(self):
        exposed = _allowlisted_keys("inventory_resources")
        self.assertTrue(exposed, "inventory_resources view exposes no projected data keys")
        for rtype, keys in inv.PROJECTIONS.items():
            for k in keys:
                self.assertIn(k, exposed,
                              f"PROJECTIONS[{rtype!r}] asks for data->{k!r} but the sql_reader view "
                              f"does not expose it — the connector would read null under the reader "
                              f"role. Add it to the migration's allowlist (a rule-3 widening) or stop "
                              f"projecting it.")

    def test_the_row_copy_key_is_never_exposed(self):
        # flow-topology.ts stores the ENTIRE source row under meta.row; exposing it would re-expose
        # every column the views deliberately omit.
        self.assertNotIn("row", _allowlisted_keys("topology_nodes"))

    def test_neither_jsonb_column_is_selected_raw(self):
        # A bare `data` / `meta` in the column list (not inside a projection) is the fail-open shape.
        for table, col in (("inventory_resources", "data"), ("topology_nodes", "meta")):
            cols = _view_columns(table)
            # Strip the projection expression itself (it legitimately ends "…)) AS data"), which
            # spans several quoted SQL fragments, then look for a bare mention in what is left.
            bare = re.sub(r"\(SELECT.*?AS\s+" + col, "", cols, flags=re.S)
            self.assertNotRegex(bare, r"(^|[,\s'])" + col + r"($|[,\s'])",
                                f"{table}.{col} appears to be selected raw — INVARIANT rule 5")

    def test_the_views_still_carry_the_columns_the_connector_selects(self):
        # The outage was a missing column, so assert presence explicitly rather than inferring it.
        for table, needed in (
            ("inventory_resources", ["resource_type", "account_id", "resource_id", "data"]),
            ("topology_nodes", ["account_id", "id", "kind", "label", "class", "meta"]),
        ):
            cols = _view_columns(table)
            for c in needed:
                self.assertIn(c, cols, f"{table} view lost {c!r}, which inventory_read_mcp selects")


if __name__ == "__main__":
    unittest.main()
