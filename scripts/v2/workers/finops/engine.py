"""ADR-019 FinOps baseline engine — orchestrates the run: evaluate every active catalog rule,
apply guards, upsert findings (dedupe key: rule_id + resource_id), resolve findings that stopped
reproducing, and (best-effort) attach an LLM explanation to anything new or changed this run.

Amounts and status are decided entirely above the LLM line (catalog.py + rules.py + guards.py); this
module never computes a dollar figure itself. One rule raising does NOT fail the run or touch that
rule's existing findings (a partial batch is better than none, and a transient AWS API error must
not resolve-away yesterday's real findings for that rule)."""
from . import catalog, guards, llm


def _start_run(conn):
    rows = conn.run("INSERT INTO finops_runs (status) VALUES ('running') RETURNING id")
    return rows[0][0]


def _finish_run(conn, run_id, *, status, rules_evaluated, findings_count, ce_api_calls, error=None):
    conn.run(
        "UPDATE finops_runs SET status=:s, finished_at=now(), rules_evaluated=:re, "
        "findings_count=:fc, ce_api_calls=:ce, error=:e WHERE id=:id",
        s=status, re=rules_evaluated, fc=findings_count, ce=ce_api_calls, e=error, id=run_id,
    )


def _upsert_finding(conn, run_id, rule_id, item, status, guard_hits):
    import json
    rows = conn.run(
        "INSERT INTO finops_findings "
        "  (run_id, rule_id, resource_id, title, category, status, monthly_savings_usd, evidence, "
        "   guard_hits, first_seen_at, last_seen_at) "
        "VALUES (:run_id, :rule_id, :rid, :title, :cat, :status, :savings, :ev::jsonb, :guards, now(), now()) "
        "ON CONFLICT (rule_id, resource_id) DO UPDATE SET "
        "  run_id = EXCLUDED.run_id, title = EXCLUDED.title, category = EXCLUDED.category, "
        "  status = EXCLUDED.status, monthly_savings_usd = EXCLUDED.monthly_savings_usd, "
        "  evidence = EXCLUDED.evidence, guard_hits = EXCLUDED.guard_hits, "
        "  last_seen_at = now(), resolved_at = NULL "
        "RETURNING id",
        run_id=run_id, rule_id=rule_id, rid=item["resource_id"], title=item["title"], cat=item["category"],
        status=status, savings=item.get("monthly_savings_usd"), ev=json.dumps(item.get("evidence") or {}),
        guards=guard_hits,
    )
    return rows[0][0]


def _resolve_stale(conn, rule_id, seen_resource_ids):
    """Findings for this rule that existed before but were NOT reproduced this run -> resolved.
    Only called for a rule that evaluated successfully this run (see run() below) — a rule that
    raised must never resolve-away its own prior findings."""
    conn.run(
        "UPDATE finops_findings SET status='resolved', resolved_at=now() "
        "WHERE rule_id=:rid AND status != 'resolved' AND resource_id != ALL(:seen)",
        rid=rule_id, seen=list(seen_resource_ids) or [""],
    )


def _explain_pending(conn):
    """Best-effort: attach an LLM explanation to any finding missing one. Bounded per run (a
    daily batch, not a chat request) — a slow/throttled Bedrock call degrades that one row to
    explanation_ko=NULL, never blocks the others or fails the run."""
    rows = conn.run(
        "SELECT id, title, category, monthly_savings_usd, evidence FROM finops_findings "
        "WHERE status != 'resolved' AND explanation_ko IS NULL LIMIT 200"
    )
    for fid, title, category, savings, evidence in rows or []:
        text = llm.explain(title, category, savings, evidence)
        if text:
            conn.run("UPDATE finops_findings SET explanation_ko=:t WHERE id=:id", t=text, id=fid)


def run(_payload, conn):
    run_id = _start_run(conn)
    ce_calls = [0]
    evaluated, persisted = 0, 0
    try:
        for rule in catalog.active_rules():
            evaluated += 1
            try:
                items = rule["fn"](conn, ce_calls)
            except Exception as e:  # noqa: BLE001 — one rule's failure must not sink the batch
                print(f"[finops] rule {rule['id']} failed (skipped this run, prior findings untouched): {e}")
                continue
            seen = []
            for item in items:
                hits = guards.guard_hits(tags=item.get("tags"), finding_reason=item.get("finding_reason"),
                                         stale=item.get("stale", False))
                status = "needs_review" if hits else "active"
                _upsert_finding(conn, run_id, rule["id"], item, status, hits)
                seen.append(item["resource_id"])
                persisted += 1
            _resolve_stale(conn, rule["id"], seen)
        _explain_pending(conn)
        _finish_run(conn, run_id, status="succeeded", rules_evaluated=evaluated,
                    findings_count=persisted, ce_api_calls=ce_calls[0])
        return {"run_id": run_id, "rules_evaluated": evaluated, "findings_count": persisted,
                "ce_api_calls": ce_calls[0]}
    except Exception as e:  # noqa: BLE001 — surface on the run row, then re-raise (SFN Catch -> failed)
        _finish_run(conn, run_id, status="failed", rules_evaluated=evaluated,
                    findings_count=persisted, ce_api_calls=ce_calls[0], error=str(e)[:2000])
        raise
