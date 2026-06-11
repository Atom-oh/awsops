# High-risk ADR reversal — co-agent consensus + decision (2026-06-11)

> Panel: kiro · codex · gemini (model-diverse, 3/3 quorum) · Claude chair. Owner-initiated
> re-review ("리스크가 큰 ADR을 다시 확인하여 결정을 번복하자"). All subjects were built but shipped
> **flag-OFF** ($0/dark), so reversal = decision-level + freeze (keep the harmless dark code).

## Context that drove the call
AWSops v2 is an **AWS-only, small-team operations DASHBOARD** (real-time inventory/cost/AI-diagnosis),
already useful **read-only**. The high-risk tier (mutation, autonomy, external endpoints) was just
built behind disabled flags. The question: should AWSops pursue these *directions* at all?

## Verdicts (raw agreement)
| ADR | codex | gemini | kiro | Consensus |
|---|---|---|---|---|
| 029 + 036 — mutating/remediation substrate | REVERSE | REVERSE | REVERSE | **REVERSE (3/3)** |
| 031 Phase 3 — BYO-MCP (external tool servers) | REVERSE | REVERSE | REVERSE | **REVERSE (3/3)** |
| 031 Phase 4 — mutating tools via 029 | REVERSE | REVERSE | REVERSE | **REVERSE (3/3)** |
| 032 — autonomous incident lifecycle | DOWNGRADE | DOWNGRADE | REVERSE | **DOWNGRADE** (keep read-only investigation/Triage/RCA; drop autonomous mitigation/action) |
| 035 — K8sGPT in-cluster diagnosis | DOWNGRADE | KEEP | DOWNGRADE | **DOWNGRADE** (keep read-only Result-CRD integration; drop the H3a → 032/034/029 wiring) |
| 034 — RCA write-back (OpsCenter) | KEEP | KEEP | KEEP | **KEEP (3/3)** |

## Decisive rationale (unanimous theme)
AWSops' core value = **read-only ops dashboard + AI-assisted diagnosis**. Mutation / autonomy /
external-endpoint directions are **scope-creep a small team cannot safely maintain**, duplicate what
operators already run (SSM, Change Manager, IaC, console/CLI), and carry a permanent security/
maintenance surface (IAM blast radius, approval/rollback correctness, egress/SSRF/credential custody,
Sandbox-schema coupling). **Analysis stays in AWSops; action stays with humans / existing tooling.**

Dissent resolved by the chair: 032 — 2× DOWNGRADE vs 1× REVERSE → DOWNGRADE (its mitigation path
depended on 029/036, which is reversed, so the action path is moot; the read-only investigation/RCA
value is retained). 035 — keep the GET-only Result-CRD integration (all three agree it's low-risk);
abandon only the H3a autonomy/remediation wiring.

## Decision (owner-confirmed 2026-06-11) — status reversal + freeze
- **REVERSE:** ADR-029, ADR-036, ADR-031 Phase 3, ADR-031 Phase 4. Status → Reversed; flags stay
  `false` permanently with a **do-not-enable** marker. The flag-OFF substrate code is harmless ($0/
  dark) and is **frozen, not deleted** (cheap to revisit; deleting applied migrations is destructive).
- **DOWNGRADE:** ADR-032 (autonomous mitigation/action path abandoned; read-only Triage/investigation/
  RCA retained, recommendation-only, NO routing to the reversed 029/036). ADR-035 (read-only K8sGPT
  Result integration retained; H3a → 032/034/029 wiring abandoned).
- **KEEP:** ADR-034 (observability-write; low blast radius).

## What changes vs not
- **Changes:** ADR statuses + a "Decision Reversal" section per affected ADR; flag descriptions get a
  do-not-enable marker; the ADR index reflects the reversal. The read-only product is unaffected.
- **Does NOT change:** the LIVE read-only dashboard, ADR-031 Phase 1/2 (custom-agent catalog + per-
  account scoping — live), ADR-034, ADR-035's read-only path, all inventory/cost/chat/EKS-read.
- **Frozen dark code remains** (remediation/incident/writeback/k8sgpt substrates, flag-OFF). A future
  owner can delete it as cleanup or revisit a reversal; nothing runs while the flags are false.
