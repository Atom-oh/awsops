# Decisions — AI Guidance

Start with [BASELINE.md](BASELINE.md): product goal, invariants, gate register, and decision index.
The numbered ADRs explain accepted decisions and rationale. [ADR-MAPPING.md](ADR-MAPPING.md)
resolves legacy numbers; an old plan, review, or implementation comment is not current authority.

## Editing and review

- Keep current decision and reviewer docs concise and English-only. Preserve acceptance dates,
  rationale, explicit owner overrides, and the limits of dated evidence.
- Distinguish accepted policy, checked-in implementation, declared defaults, and observed deployment.
  A merged change or a default value does not prove deployment. Date live observations and cite evidence.
- Verify paths in the reviewed checkout. This checkout uses `terraform/v2/foundation/`.
  Do not import paths or ADR numbering from another repository or historical branch.
- Cite current decisions as `ADR-NNN`; qualify provenance as `legacy ADR-NNN` or
  `ADR-NNN[legacy MMM]`. Legacy bodies are preserved at `adr-legacy-2026-06-22`; do not read
  them without an explicit request. Historical records remain historical.
- ADR filename: `NNN-kebab-case-title.md`.
- New ADR: highest existing numbered ADR plus one, with Status, Context, Decision, Consequences,
  and relevant Well-Architected pillars. Update BASELINE's index/register in the same change.
- Read actual call paths and flag dependencies before reporting a violation. Report policy/code
  conflicts explicitly; neither stale prose nor existing code silently authorizes a policy reversal.

## Boundaries that reviewers must preserve

- ADR-005 freezes AWS-resource mutation/autonomous mitigation and arbitrary BYO-MCP. Retained
  disabled code is intentional. Unfreezing requires a new ADR, multi-AI review, and a dated owner override.
- ADR-015 grants exactly the own-Aurora-secret rotation restart of the host web service. It is an
  explicit exception, not general self-healing permission. Its flag defaults false; the BFF now uses IAM DB auth.
- ADR-006 gates analysis-only incident/RCA/K8sGPT paths. RCA write-back cannot enable its frozen
  remediation dependency; it needs an independent role first.
- ADR-007 permits governed external data reads/writes. SNS notifications and broad integration
  writes have separate controls; arbitrary MCP registration stays prohibited.
- ADR-017's hosted presets are gated with a runtime tool allowlist; ClickHouse stdio stays frozen.
- ADR-021 permits bounded batch inventory ingestion. Live BFF Steampipe execution remains disabled;
  direct domain MCP tools still coexist with the Aurora reader pending the accepted cutover.
- ADR-019's isolated SELECT-only Athena pipeline is inside the read-only invariant, not a freeze exception.

## Generated reviewer context

`AGENTS.md` is distilled from this file. Run the installed `/co-agent sync-context`
workflow after editing this source; it updates the distilled body and validates
its marker, size and content. The helper's `--emit-marker` only emits metadata;
it does not regenerate the body. Never update a hash without reviewing the context.
