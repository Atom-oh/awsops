<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: d77cfa6460b4 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Gemini, an external reviewer — project context below.

# docs/decisions — Architecture Decision Records (ADR)

This directory is the canonical log of major design decisions for AWSops. It contains
ADR files plus this index. ADRs are documents only — no executable code lives here.

## What a reviewer must enforce

**File & format conventions**
- Filename: `NNN-kebab-case-title.md` — three-digit zero-padded number, kebab title.
- New ADR number = highest existing + 1 (no gaps, no reuse). Use `/project-init:add-adr`.
- Document structure: `Status / Context / Decision / Consequences` (Consequences split into
  Positive / Negative / Post-acceptance deviations).
- Bilingual: Korean + English side by side for all new content.
- Status vocabulary is fixed: `Proposed`, `Accepted (YYYY-MM-DD)`, `Superseded by NNN`,
  `Deprecated`. An ADR starts `Proposed`; on decision it flips to `Accepted (YYYY-MM-DD)`.
- Every status/outcome change must also update the index table in the CLAUDE.md of this dir.
  An ADR whose body changed but whose index row didn't (or vice versa) is a defect.

**Supersession & reversal discipline (the high-value gotchas)**
- A superseding ADR does NOT delete the old one — the superseded ADR stays as history with a
  `Superseded by NNN` marker. Never silently drop a row.
- Distinguish three lifecycle verbs precisely; reviewers should flag misuse:
  - **Superseded** — replaced by a newer ADR (intent may survive even when mechanism changes).
  - **REVERSED** — a decision was rolled back, frozen `do-not-enable`; dark code may be retained
    but must stay flag-OFF.
  - **DOWNGRADED** — partially walked back (e.g. autonomous action dropped, read-only kept).
- When an ADR's mechanism is superseded but its *intent* is kept (or vice versa), the index row
  must say which half survives — do not let an edit collapse that nuance.

## Architectural boundary this directory encodes

The ADR log records, and a reviewer should hold the rest of the codebase to, the core product
boundary: **AWSops is a read-only ops dashboard + AI diagnosis.** AWS-resource mutation and
autonomy are permanently frozen (do-not-enable, flag-OFF). The later re-scope clarifies that
the read-only constraint targets *AWS-resource mutation + autonomy*, NOT external data: governed
external observability *read* and external record/ticket/message *write* are permitted only under
controls (SSRF defense, secrets handling, DLP/redaction, curation, human-gate, flag-OFF default).
Any change that enables a mutating/autonomous AWS path, or an ungoverned external egress, should
be challenged against this boundary regardless of which feature PR proposes it.

## v1 vs v2 scope note (implied by the index)

The repo runs two architectures in parallel; ADRs mark which lineage each decision belongs to:
- **v1** (`src/`, CDK/EC2/Steampipe, `/awsops` basePath) — legacy production, untouched.
- **v2** (`web/`, `terraform/v2/`) — Terraform · ECS Fargate · Aurora · AgentCore · async workers.

Several v1 ADRs are explicitly *superseded for v2 only* (the v2 ADR carries the decision forward,
the v1 body remains as history). When reviewing, check that a cited ADR's status actually applies
to the lineage of the code under review — a v1-scoped Accepted is not authority for a v2 change,
and v2 supersedes (e.g. CDK→Terraform, live-Steampipe→flag-gated inventory sync) do not retroactively
rewrite v1 history.

## Banned patterns

- Editing an ADR body without updating the index row (or vice versa).
- Reusing or skipping ADR numbers.
- Removing a superseded/reversed ADR instead of marking it.
- Treating a REVERSED/frozen decision as if it were merely Superseded (i.e. re-enabling its code).
- Adding monolingual (Korean-only or English-only) ADR content.
