# Observability Evidence and Limits

Policy: [BASELINE](../decisions/BASELINE.md). This reference separates implemented
evidence paths from incomplete producer integration; it does not claim a deployed
end-to-end outcome from an interface or unit fixture alone.

## Trace and graph evidence

[trace-source.ts](../../web/lib/trace-source.ts) returns `SourceRead<T>` with
items, status, source ID, safe reason codes, and the exact read window. Missing
configuration, query failure, truncation, malformed rows, and successful empty
results must remain distinguishable. Reasons exclude raw exceptions/credentials.
[graph-sources.ts](../../web/lib/graph-sources.ts) resolves registered adapters;
a registry error is evidence failure, not a silent successful fallback.

[trace-graph.ts](../../web/lib/trace-graph.ts) preserves source/trace/span identity,
cloud and Kubernetes scope, and asynchronous links. Service names alone do not
establish identity. Metric counts and sampled spans remain separate evidence.
[trace-evidence.ts](../../web/lib/trace-evidence.ts) marks messaging destinations
as telemetry claims; even a destination ARN is not AWS-verified queue attribution.
Do not infer the queue's account from the reporting workload or attach an inventory
reference without independent evidence.

[graph-store.ts](../../web/lib/graph-store.ts) collects one shared 60-minute window,
requests up to 1,000 spans per adapter, and caps materialization at 200 nodes and
500 edges. Caps, orphans, invalid spans, unresolved messaging, and missing infra
coverage make results partial. A failed/unavailable source retains the prior
snapshot while recording the failed attempt; complete empty collection may publish
an empty graph. Attempt ordering and the trace advisory lock prevent older results
from replacing newer state.

[graph-state.ts](../../web/lib/graph-state.ts) exposes status and freshness through
`/api/graph`, including empty graphs. Missing state is unknown/stale. Freshness uses
the capture timestamp and a threshold of at least 15 minutes or twice the configured
rebuild interval; errors/unavailability/retained snapshots are stale independently.
Do not replace a missing timestamp with the current clock.

## Diagnosis trust

[sources.py](../../scripts/v2/workers/diagnosis/sources.py) currently supplies
unresolved X-Ray `to_ref` edges and no inventory `unencrypted` aggregate.
[invariants.py](../../scripts/v2/workers/diagnosis/invariants.py) requires a different
normalized shape. Current collectors therefore leave the implemented invariant
kinds unknown; positive/zero unit fixtures prove the evaluator contract, not live
collector coverage. Producer adapters and collector-to-verdict integration remain
incomplete. Empty drift/improvement lists are not evidence of health.

[report.py](../../scripts/v2/workers/diagnosis/report.py) persists assessed/unassessed
coverage and renders Intended vs Actual deterministically, independently of the
model. [DiagnosisView](../../web/components/diagnosis/DiagnosisView.tsx) displays
coverage and treats legacy reports without it as unassessed. Valid normalized
violations can be reported with partial evidence; a pass requires complete usable
evidence. Preserve `test_invariants.py` and `test_intended_vs_actual.py` semantics.

[exporters.py](../../scripts/v2/workers/diagnosis/exporters.py) sanitizes PDF HTML
and renders with JavaScript disabled, service workers blocked, offline browser
context, and context-wide request blocking. Export failure is isolated from the
primary Markdown report. Browser resource-request tests verify isolation where
Chromium is available; a skipped browser test does not prove it ran.

## Job timing and outcomes

[Job observability](../../web/app/api/jobs/observability/route.ts) is ownership/admin
scoped. It accepts a 1–168 hour window, samples at most 2,000 rows with a count from
the same query snapshot, and returns the latest 50 jobs. Incomplete samples or
missing timestamps suppress complete-coverage attainment/percentile claims.

[job-observability.ts](../../web/lib/job-observability.ts) measures acceptance to
first worker start and first start to terminal state, including retries. This is
worker lifecycle time, not CPU time or pure queue delivery latency. Migration-owned
`started_at`/`finished_at` preserve terminal timing; unknown legacy timestamps remain
unknown. The `/jobs` view consumes these explicit coverage fields.

Workload-wide deployment/change correlation, allocated-cost outcomes, and causal
quality evaluation still require connected producers and validation. Routing
accuracy or disappearance of a recommendation does not establish diagnosis quality
or verified savings.
