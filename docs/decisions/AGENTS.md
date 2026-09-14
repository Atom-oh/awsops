<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: bbc5a8e493d3 · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

# Decisions — Reviewer Context

Start with [BASELINE.md](BASELINE.md); numbered ADRs state accepted decisions and rationale.
[ADR-MAPPING.md](ADR-MAPPING.md) qualifies legacy references. Historical plans, reviews, and comments
are evidence of their time, not current enforcement or permission.

- Keep decision docs concise and English-only. Preserve acceptance dates, rationale, owner overrides,
  and evidence limits. Distinguish policy, checked-in code, defaults, and dated deployment observations.
- Verify the reviewed checkout: this checkout uses `terraform/v2/foundation/`. Resolve current
  `ADR-NNN` separately from `legacy ADR-NNN` / `ADR-NNN[legacy MMM]`; do not read legacy tag bodies
  without an explicit request.
- New ADR = highest existing number plus one, with a same-change BASELINE index/register update.
  Report policy/code conflicts explicitly; neither existing code nor stale prose reverses a decision.
- **ADR-005 FROZEN:** AWS-resource mutation/autonomous mitigation, arbitrary BYO-MCP, mutating tools.
  Disabled substrate is intentional. Reversal needs a new ADR, multi-AI panel, and dated owner override.
- **ADR-015 exception:** own-Aurora-secret rotation restart of the host web service only, default-off.
  No general self-healing permission. Current web IAM DB auth makes password-injection rationale historical.
- **ADR-006 GATED:** analysis-only incident/RCA/K8sGPT. Write-back needs role separation; never enable
  frozen remediation to satisfy the current dependency.
- **ADR-007:** governed external data reads/writes are permitted. Single-topic SNS and broad writes
  have separate controls. Attribute transport/DLP/approval controls to their actual call paths.
- **ADR-017:** hosted presets are gated behind endpoint acknowledgement and runtime tool allowlists;
  ClickHouse stdio remains frozen.
- **ADR-021:** bounded batch inventory is supported while live BFF Steampipe execution stays disabled.
  Aurora inventory reads and direct domain tools coexist; the accepted cutover is not yet implemented.
- **ADR-019:** isolated SELECT-only Athena queries are inside the read-only invariant, not a new freeze exception.

Regenerate this context after editing CLAUDE.md with the installed co-agent marker/check helper.

Use `NNN-kebab-case-title.md` for ADR filenames.
