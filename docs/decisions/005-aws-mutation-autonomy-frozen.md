# ADR-005: AWS Mutation and Autonomous Mitigation Are Frozen

## Status

Accepted **2026-06-22**. Consolidates legacy ADRs 029, 036, and 031 phase 4.
The governing reversal is **2026-06-11**, owner-directed with a three-AI panel (Kiro, Codex, Gemini).
Evidence: `docs/history/reviews/2026-06-11-high-risk-adr-reversal-consensus.md`.
ADR-015 later records one explicit, dated exception; everything else below remains frozen.

## Context

Infrastructure mutation and autonomous mitigation exceed the blast radius a small team can safely
own and are unnecessary for evidence-based diagnosis. Earlier execution controls were implemented
behind disabled flags; their design does not authorize enabling them.

## Decision

1. Keep `remediation_enabled=false` and do not enable successor flags, tool wiring, or execution
   paths that create/update/delete AWS infrastructure or perform autonomous mitigation. Arbitrary
   BYO-MCP and mutating tools remain prohibited. Ordinary approval screens do not lift this freeze.
2. Retain disabled catalogs, audit tables, executors, and workflow branches. Their presence is
   intentional; the regression is making the frozen capability reachable or granting it active authority.
3. Reversal requires **all three**: a new ADR explicitly reversing the 2026-06-11 decision,
   multi-AI panel review, and a dated owner override. Documentation cleanup, comments, and self-scoping
   reinterpretation cannot substitute for that process (governance clarification **2026-06-16**).
4. Apply only ADR-015's exact exception: the host web service's own Aurora-secret rotation restart,
   default-off and narrowly scoped. It is an acknowledged autonomous AWS write, not permission for a
   general self-healing category or a second service.
5. External DATA writes are separately governed by ADR-007. Reusing control/workflow infrastructure
   for that tier must not enable AWS mutation: independent flags, kill-switch, and no-AWS-mutation IAM.
   Internal application data persistence and ADR-019's constrained query mechanics are not remediation.

Operator-directed deployment or retirement work is distinct from enabling autonomous product behavior;
ADR-016 records the retirement decision and its own evidence. This ADR supplies no new operational authorization.

## Consequences

The product stops at diagnosis and proposed fixes; operators execute infrastructure changes through
separately governed tools. Disabled code carries maintenance cost but is not itself a finding.
Read-only does not mean zero security or availability risk: reads consume quotas (ADR-021), data can
be exposed, and ADR-015 has an explicit bounded write capability.

## Six Pillars

Security: prevent product-driven infrastructure mutation and avoid accidental activation.
Operational Excellence: explicit, auditable decisions and separation of diagnosis from execution.

## Evidence

`terraform/v2/foundation/{variables,remediation}.tf`; ADR-007, ADR-015, ADR-019, and ADR-021.
Use [ADR-MAPPING.md](ADR-MAPPING.md) for legacy provenance; historical mechanisms are not current permission.
