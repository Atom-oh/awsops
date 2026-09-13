# Documentation map

New/rewritten developer and reviewer documentation is English-only. Existing
bilingual bodies are a migration backlog, not a requirement for new parallel text.
Multilingual product guides
remain under `docs-site/`. Read only the sources relevant to the changed behavior.

| Need | Source |
| --- | --- |
| Project instructions and build commands | [CLAUDE.md](../CLAUDE.md) |
| Current decisions, invariants and feature gates | [Decision baseline](decisions/BASELINE.md) |
| Legacy ADR number mapping | [ADR mapping](decisions/ADR-MAPPING.md) |
| Architecture | [Architecture](architecture.md) |
| Layer implementation details | [Reference index](reference/README.md) |
| Developer setup | [Onboarding](onboarding.md) |
| Testing and troubleshooting | [Guides](guides/) |
| Generated architecture visuals | [Diagrams](diagrams/) |
| API routes | [API reference](api-reference.md), verified against `web/app/api/**/route.ts` |
| Operations | [Runbook index](runbooks/CLAUDE.md) |
| Merge and AI-review checks | [Verification](v2-merge-verification.md) |
| UI design conventions | [Design](../DESIGN.md) |

`plans/`, `specs/`, `reviews/`, `superpowers/` and `history/` are dated records.
They can explain why an implementation exists, but cannot establish current policy,
feature enablement or deployment. In particular, `superpowers/reference/` is an old
planning copy; `reference/` is the maintained implementation reference. Historical
records retain their original language/evidence. Do not translate an old approval
into a new decision or load archives as default reviewer context.

The origin repository owns decision bodies. Public samples may cite ADR numbers
without shipping private records. Always resolve code paths against the repository
being reviewed: private Terraform uses `terraform/v2/foundation/`, public samples
use `terraform/foundation/`.

A material contradiction should identify both sources and the actual code path.
Do not suppress a real security regression because prose is stale, or infer one
solely from an obsolete plan, test label, component count or translation rule.
