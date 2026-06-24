"""AI Insights worker job — collect (K8s/CloudWatch/cost) → synthesize → store latest in ai_insights.

Runtime-gated on AI_INSIGHTS_ENABLED (set on the worker by terraform local.aii) so the always-registered
REGISTRY entry + the BFF enqueue path are a strict no-op when the feature is off. Read-only; never raises
(per-collector failure is isolated; all-failed → status 'failed' row; a store error is surfaced).
"""
import logging
import os

from insight import cost_anomalies, cw_anomalies, generate, k8s_events


def run(payload, conn):
    """Return a small result dict. Never raises."""
    if os.environ.get("AI_INSIGHTS_ENABLED") != "true":
        return {"disabled": True}
    fns = [k8s_events.collect_k8s_events, cw_anomalies.collect_cw_anomalies, cost_anomalies.collect_cost_anomalies]
    signals, failures = [], 0
    for fn in fns:
        try:
            signals.append(fn())
        except Exception as e:  # noqa: BLE001 — collectors are defensive; this guards stubs/regressions
            logging.warning("[insight.job] collector %s failed: %s", getattr(fn, "__name__", fn), e)
            failures += 1
    try:
        if failures == len(fns):
            import db as wdb
            wdb.insert_insight(conn, "failed", [], {}, model=None, error="all collectors failed")
            return {"status": "failed"}
        result = generate.synthesize(signals)
        sources_used = {s.get("source"): len(s.get("items") or []) for s in signals}
        import db as wdb
        wdb.insert_insight(conn, result["status"], result["insights"], sources_used, model=result.get("model"))
        return {"status": result["status"], "count": len(result["insights"])}
    except Exception as e:  # noqa: BLE001 — store/synth failure must not crash the worker
        logging.warning("[insight.job] run failed: %s", e)
        return {"error": str(e)[:300]}
