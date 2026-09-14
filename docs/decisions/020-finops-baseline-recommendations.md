# ADR-020: Deterministic FinOps Baseline Recommendations

## Status

Accepted **2026-08-19**, extending ADR-012. Repository evidence checked **2026-09-13**.

## Context

Cost trends and chat tools do not provide a persistent, evidence-based waste summary. This feature has
no CUR/FOCUS line-item ingestion; **that is a limit of this cost feature**, not a claim that Athena
is absent from the repository (ADR-019 uses Athena for Flow Logs).

## Decision

- Deterministic rules own findings and money. LLM text only explains established findings; discard
  explanations whose numbers conflict. LLM failure leaves the deterministic feature usable.
- Implemented inputs are synchronized EBS inventory/rate-card evidence and Compute Optimizer
  EC2/RDS recommendations. The baseline batch does not invoke Cost Explorer, Cost Optimization Hub,
  or Budgets merely because chat supports those APIs. Keep unavailable CUR-dependent rules visibly
  registered as `requires_cur`, not executed or reported as no findings.
- Unknown savings remain **NULL**, never zero. Preserve account/region/resource identity and data
  timestamps. The API sorts by savings with nulls last; there is no engine-owned priority score.
- Run a daily Fargate `finops_baseline` job behind `finops_baseline_enabled` (default false), requiring
  `workers_enabled`. Grant only the actual Compute Optimizer operations directly to the worker role;
  this path does not require AgentCore. The cost-page findings section reads Aurora, not live APIs.
- EBS findings additionally require valid successful inventory-sync evidence. Without it, expose a
  partial run rather than pretending the rule checked an empty fleet. Terraform's worker dependency
  alone does not guarantee all rules have usable inputs.
- Downgrade guarded findings to `needs_review`, exposing `guard_hits`. Implemented guards cover
  retention/DR tags, insufficient observation history, and stale inventory. Do not describe proposed
  Graviton/Spot/tag-coverage guards or CE-call accounting as implemented rules.
- Provide recommendation/IaC text only. No resize, purchase, execution button, or other AWS-resource
  mutation is authorized. ADR-005 remains unchanged.

## Consequences

Daily findings provide explainable savings opportunities without requiring model correctness.
Freshness and missing inputs limit conclusions; accepted scope does not include line-item allocation
or every recommendation API. `finops_runs.ce_api_calls` is retained for future CE rules and is zero
for the currently implemented rule set. Historical COH IAM alignment concerns the MCP path, not
permission to add broad API access to this batch.

## Six Pillars

Cost Optimization: deterministic savings evidence. Reliability: isolated batch and optional narration.
Security: read-only inputs and no execution. Operational Excellence: visible guard/missing-input state.
Sustainability: recommendations can identify idle resources for operators to assess.

## Evidence

`scripts/v2/workers/finops/{catalog,rules,guards,engine,llm}.py`,
`scripts/v2/workers/finops_dispatcher.py`, `terraform/v2/foundation/workers.tf`, ADR-009/010/012.
