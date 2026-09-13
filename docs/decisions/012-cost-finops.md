# ADR-012: Cost and FinOps

## Status

Accepted **2026-06-22**, consolidating legacy ADRs 006 and 015.
Extended by ADR-020 **2026-08-19**. Cost-page probe/change-alert behavior extended **2026-09-01**.
Repository evidence checked **2026-09-13**.

## Context

Spend visibility, optimization recommendations, and AWSops' own AI usage have different data sources
and availability. Denied or unconfigured cost APIs should not cause repeated failures or fabricated zeroes.

## Decision

- Provide Cost Explorer trends, month-over-month comparison, and forecast views. The current BFF
  contains bounded Cost Explorer calls; the thin-BFF rule is not a ban on every direct AWS SDK read.
- Probe Cost Explorer availability directly and cache the host verdict for one hour. The cost page's
  user-requested empty-data probe does not force a refresh or become an all-account probe.
  Keep last-good per-account/month snapshots in process and disclose fallback state. They are not
  durable local JSON snapshots and do not survive process replacement.
- Day-normalized service changes use completed UTC days. Incomplete or unsuitable evidence produces
  no verdict, rather than an apparent saving/increase based on incompatible time windows.
- Keep FinOps MCP tools separate from spend views. Handle denied/not-enabled/support-plan-limited
  recommendation APIs with structured unavailable reasons. IAM must enumerate actual read operations;
  an old `cost-optimization-hub:*` example is not authority for a wildcard grant.
- Aggregate Bedrock invocation usage into Aurora `ai_usage_daily` behind `ai_cost_tracking_enabled`
  (default false). Preserve AWSops attribution through configured inference profiles and invocation
  logs. Empty usage can mean no attributable data, not zero total Bedrock spend.
- ADR-020 owns the deterministic baseline recommendations batch. Its implemented inputs are narrower
  than all APIs available to chat; do not attribute the MCP toolset to every baseline rule.

## Consequences

Availability caching avoids repeated known-bad probes, but can delay recognition of restored access.
Snapshots and recommendations have explicit freshness limits. Cost usage aggregation depends on its
own gate/log configuration; source code does not prove deployment. All outputs are read-only findings
and proposals; no purchase, resize, or resource mutation is authorized.

## Six Pillars

Cost Optimization: visible spend, recommendations, and AI usage. Operational Excellence: explicit
availability/freshness and measured cost attribution. Security: read-only tools with scoped IAM.

## Evidence

`web/lib/{cost,cost-availability,cost-basis}.ts`, `web/app/api/cost/route.ts`,
`agent/lambda/aws_finops_mcp.py`, `scripts/v2/workers/ai_cost_aggregator.py`,
`terraform/v2/foundation/{ai,workers}.tf`, and ADR-020.
