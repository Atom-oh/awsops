<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 24f2a7322fc6 · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> Reviewer context distilled from this module’s CLAUDE.md; shared by Kiro, Codex, and Agy.

# Agent Runtime Review

Use root [CLAUDE.md](../CLAUDE.md) and
[BASELINE.md](../docs/decisions/BASELINE.md) for policy.

- `agent.py` runs gateway selection and streaming. Live tools come from
  `scripts/v2/agentcore/catalog.py`, `provision.py`, and
  `terraform/v2/foundation/ai.tf`; inspect those rather than copied counts.
- The early `deployment_readiness` branch in `readiness.py` checks STS account,
  curated Ops gateway inventory tools, a known fresh CloudFront record and a bounded
  model call. Return nonce/account-bound evidence, exclude inventory from the model
  prompt and never fall through to normal chat on readiness failures.
- Preserve the `observability`/`external-obs` alias and canonical/`v2-` gateway
  compatibility. Host requests use execution credentials through
  `account_utils.py` and `lambda/cross_account.py`, not self-assume.
- Normal chat tool-less fallback applies before output begins; do not replay a partial
  response. BFF fan-out requires both hybrid-routing and synthesis flags.
- Keep runtime tool allowlists, server-controlled gates, and arm64 images.
  AWS mutation/autonomy and arbitrary BYO-MCP stay FROZEN; governed external-data
  capabilities follow BASELINE. Do not embed credentials in source or prompts.
- Keep application language behavior unchanged.

From the repository root:

```bash
cd agent && python3 -m pytest test_agent.py test_readiness.py -q
```

Run other affected Python suites in isolation, following
`scripts/v2/merge-verify.sh`.
