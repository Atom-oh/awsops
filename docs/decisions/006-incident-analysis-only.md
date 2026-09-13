# ADR-006: Gated Incident Analysis Only

## Status

Accepted **2026-06-22**. Consolidates legacy ADRs 009, 032, 034, and 035 after the
**2026-06-11** owner/panel reversal of autonomous mitigation (ADR-005).
Repository evidence checked **2026-09-13**.

## Context

Alert correlation, investigation, RCA, and prevention recommendations remain useful without executing
mitigation. Historical workflow stages and write-back roles depended on the now-frozen remediation path.

## Decision

- Lifecycle stages may persist Trigger, Triage, Investigation, RCA, and Prevention state, but stop at
  evidence and recommendations. No stage invokes mutating tools or routes into frozen remediation.
- `incident_lifecycle_enabled`, `rca_writeback_enabled`, and `k8sgpt_enabled` default false.
  Lifecycle execution uses the shared worker ledger/SQS infrastructure (ADR-009); domain tables do
  not create an independent orchestration system.
- Alert payloads are untrusted input. They cannot choose privileged agents, grant authority, or approve
  actions. Label RCA as an AWSops recommendation with confidence, evidence, and timestamps; retain
  alternatives and disclose missing data rather than claiming an established root cause.
- RCA write-back is governed observability metadata, but **currently blocked**: `writeback.tf` reuses
  `action_opscenter_write`, and `variables.tf` requires frozen `remediation_enabled`.
  Separate a self-contained write-back role before enablement; never enable remediation to satisfy
  that validation. Retain `CreatedBy=AWSops-AIOps` echo suppression.
- K8sGPT integration reads Result CRDs. Operator installation is out of band; the diagnostic sensor
  is read-only/deterministic, with fixes disabled. AWSops supplies narration, treats findings as
  hypotheses, and gives conflicting deterministic evidence precedence. No cluster writes or retired
  remediation wiring follow from enabling this gate.
- Manual entry and ADR-013's authenticated alert ingress remain supported trigger designs. The webhook
  returns disabled status when the lifecycle gate is off; retained authentication code does not prove activation.

## Consequences

Diagnosis value survives without automated mitigation. State-machine retries, partial evidence, and
plausible-but-wrong RCA still need careful handling. Write-back cannot be activated with the current
frozen dependency. Read-only K8sGPT integration does not authorize installing/fixing resources through AWSops.

## Six Pillars

Reliability: evidence-driven recommendations and durable analysis state. Operational Excellence:
correlation, RCA timelines, and explicit uncertainty. Security: no mutation routing and separate write-back authority.

## Evidence

`terraform/v2/foundation/{variables,incidents,writeback,k8sgpt}.tf`,
`web/app/api/incidents/webhook/route.ts`, `scripts/v2/workers/dispatcher.py`, and ADR-005/009/013.
