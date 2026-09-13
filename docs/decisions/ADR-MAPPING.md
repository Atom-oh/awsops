# ADR Mapping: Legacy to Current

This is a provenance map, not a second decision register. Current authority is
[BASELINE.md](BASELINE.md) and the numbered ADRs beside it. Legacy bodies are preserved at
`adr-legacy-2026-06-22` and must not be read without an explicit request. Restore a requested body
with `git show adr-legacy-2026-06-22:docs/decisions/<legacy-filename>.md`.

The first column always means **legacy ADR**, never the same-numbered current decision. For example,
legacy ADR-015 is FinOps (now ADR-012); current ADR-015 is the rotation-restart exception. Qualify all
legacy citations. Phase labels describe provenance and do not prove deployment.

| Legacy ADR | Historical topic | Current destination / disposition |
|---|---|---|
| 001 | Steampipe pg Pool | ADR-001; live BFF Steampipe retired, batch inventory in ADR-021 |
| 002 | Hybrid AI routing | ADR-003 |
| 003 | SCP-blocked columns | ADR-010 |
| 004 | Gateway separation | ADR-004 |
| 005 | VPC Lambda to Steampipe | ADR-001; superseded mechanism |
| 006 | Cost availability probe | ADR-012 |
| 007 | Inventory baseline | ADR-010 |
| 008 | Multi-account support | ADR-011 |
| 009 | Alert-triggered diagnosis | ADR-006; report pipeline in ADR-008 |
| 010 | Event-driven pre-scaling | v1-only; not adopted in v2; mutation freeze applies |
| 011 | External datasources | ADR-007 |
| 012 | SNS notification strategy | ADR-013 |
| 013 | Evidence collectors | ADR-008 |
| 014 | Report proxy downloads | ADR-013 |
| 015 | FinOps MCP Lambda | ADR-012 |
| 016 | Bedrock model selection | ADR-008 |
| 017 | Cache prewarming | ADR-014; old warmer is not a live v2 path |
| 018 | Memory isolation/retention | ADR-004 |
| 019 | Report formats | ADR-008 |
| 020 | Cognito and Lambda@Edge | ADR-002 |
| 021 | SSE streaming | ADR-008; not current ADR-021 inventory policy |
| 022 | Webhook authentication | ADR-013 |
| 023 | Admin authority | ADR-002 |
| 024 | CDK stack split | ADR-001; Terraform supersedes CDK for v2 foundation |
| 025 | Parallel route synthesis | ADR-003 |
| 026 | LanguageProvider | ADR-014 |
| 027 | Interpreter sessions | ADR-004 |
| 028 | CloudFront caching disabled | ADR-014 |
| 029 | Mutation framework | ADR-005, FROZEN |
| 030 | Fargate, Aurora, dual ECR | ADR-001; accepted intent, not the old service layout |
| 031 | Custom agents and skills | ADR-004 platform; ADR-005 mutating tools FROZEN; ADR-007 curated integration only |
| 032 | Autonomous incident lifecycle | ADR-006 analysis-only; autonomous mitigation abandoned |
| 033 | LLM cost control | ADR-008 |
| 034 | RCA write-back | ADR-006, gated and blocked on role separation |
| 035 | K8sGPT | ADR-006, GET-only and gated |
| 036 | Remediation execution | ADR-005 FROZEN; shared worker spine in ADR-009 |
| 037 | Terraform v2 foundation | ADR-001, ADR-009 |
| 038 | Hybrid agent routing | ADR-003 |
| 039 | Multi-agent platform/integrations | ADR-004 platform; ADR-007 external data governance |
| 040 | Governed external write | ADR-007 |
| 041 | Resource-scoped read-only definition | ADR-007; dated owner override with PARTIAL panel verdict |
| 042 | In-app login | ADR-002 |
| 043 | Optional Neptune graph store | BASELINE deferred option; Postgres-first, no adoption |
| 044 | Multi-domain chat | ADR-003 |
| 045 | Parallel diagnosis/streaming | ADR-008; section-output streaming remains unimplemented |
| 046 | DevOps RCA orchestrator | [Historical brainstorm](../history/brainstorm/046-devops-rca-eog-PROPOSED.md); not an accepted decision |
