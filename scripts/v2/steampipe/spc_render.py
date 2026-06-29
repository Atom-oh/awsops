"""Pure renderer for the Steampipe aws.spc connection config (multi-account / multi-region fan-out).

One `connection "aws_<account_id>"` per enabled account (name = account id, never the alias —
aliases aren't unique and can collide/sanitize to empty). `all_regions` → `regions = ["*"]`;
otherwise the explicit enabled regions; an account that is NOT all-regions and has NO enabled
regions is skipped (never the backwards ["*"]-on-empty). Non-host connections carry `role_arn`
(+ `external_id` only when set; 1st-party omits it). An `aws` aggregator spans every per-account
connection so existing `aws.*` queries transparently fan out. All rendered values are HCL-escaped.
"""

PLUGIN = "aws@0.142.0"


def _hcl(s) -> str:
    """Quote + escape a string for HCL. json.dumps gives a valid double-quoted literal with full
    escaping (backslash, quote, AND control chars like newline/tab) — HCL string escaping is
    JSON-compatible, so a stray newline/control char in e.g. external_id can't break aws.spc."""
    import json
    return json.dumps(str(s))


def _regions_list(regions) -> str:
    return "[" + ", ".join(_hcl(r) for r in regions) + "]"


def render_spc(rows) -> str:
    """rows: list of {account_id, is_host, role_name, external_id, all_regions, regions[]}."""
    blocks = []
    for r in rows:
        # The HOST always scans all regions (v1 parity) regardless of the flag — it has no
        # account_regions rows, and skipping it would empty the whole inventory (C1).
        if r.get("all_regions") or r.get("is_host"):
            regions = ["*"]
        else:
            regions = [x for x in (r.get("regions") or []) if x]
            if not regions:
                continue  # target that is not all-regions and has nothing enabled → skip
        name = "aws_" + str(r["account_id"])
        lines = [
            f'connection "{name}" {{',
            f"  plugin = {_hcl(PLUGIN)}",
            f"  regions = {_regions_list(regions)}",
        ]
        if not r.get("is_host"):
            lines.append(f'  role_arn = {_hcl("arn:aws:iam::%s:role/%s" % (r["account_id"], r["role_name"]))}')
            if r.get("external_id"):
                lines.append(f"  external_id = {_hcl(r['external_id'])}")
        lines.append("}")
        blocks.append("\n".join(lines))

    blocks.append(
        'connection "aws" {\n'
        f"  plugin = {_hcl(PLUGIN)}\n"
        '  type = "aggregator"\n'
        '  connections = ["aws_*"]\n'
        "}"
    )
    return "\n\n".join(blocks) + "\n"
