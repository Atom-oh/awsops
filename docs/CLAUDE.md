# Developer documentation

Use English only for developer/reviewer docs: context files, ADRs, architecture,
references, runbooks and new plans. Keep multilingual user guides under `docs-site/`
and application i18n. Historical records preserve their original evidence and
language; do not treat them as current instructions or bulk-load them for review.

## Authority and scope

1. `decisions/BASELINE.md` is the current decision/gate register. Consolidated
   `NNN-*.md` ADRs contain rationale/amendments; update the register with a new ADR.
2. Source, migrations and tests establish behavior; accepted invariants establish
   what is allowed. Investigate disagreement rather than silently changing policy.
3. `architecture.md`, `reference/` and `runbooks/` describe current implementation.
4. `plans/`, `specs/`, `reviews/`, `superpowers/` and `history/` are dated design or
   execution records. A plan is not evidence of deployment, approval or enablement.
   `superpowers/reference/` is historical, not the current `reference/` tree.

Do not rewrite historical decisions to authorize frozen behavior. Use
`decisions/ADR-MAPPING.md` for legacy numbers; old ADR bodies are available at
`adr-legacy-2026-06-22` only when explicitly needed. Choose the next unused ADR number
from the files rather than a hardcoded count in prose.

## Maintenance

- Keep one explanation of each policy; link to it instead of copying long lists.
- Verify paths/commands against this checkout. Private Terraform lives at
  `terraform/v2/foundation/`; public samples use `terraform/foundation/`.
- Do not maintain counts of pages, routes, components or tools by hand.
- Distinguish default settings, supported capability and dated deployment evidence.
- Commands must name their working directory and avoid secrets. Use placeholders
  for example account IDs/domains; identifiers are not credentials by themselves.
- Regenerate a scoped `AGENTS.md` after its `CLAUDE.md` source changes.
- Navigation and historical scope are in `README.md`. User-site localization is
  a separate surface; lack of Korean developer text is not a review defect.
