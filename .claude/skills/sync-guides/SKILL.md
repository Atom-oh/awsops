---
name: sync-guides
description: Use when updating AWSops user guides after a confirmed product behavior change
triggers: sync guides, guide update
---

# Sync User Guides

Read root `CLAUDE.md`, `docs/decisions/BASELINE.md`, and the current docs-site
configuration. Developer/reviewer instructions are English-only; guide locale
work follows the user's requested scope and existing product localization.

1. Collect changed files from the requested diff or commit range. There is no
   automatic pending-guide queue to consume.
2. Trace visible behavior in `web/app/`, `web/components/`, `web/lib/`, `agent/`,
   `scripts/v2/`, and `terraform/v2/foundation/` as relevant.
3. Find the existing guide through `docs-site/sidebars.ts`. Update only behavior
   supported by source; distinguish disabled capabilities and operator setup.
   Read diagrams and screenshots before reusing them as evidence.
4. For requested translations, use locales and paths in
   `docs-site/docusaurus.config.ts`. Keep app i18n separate from developer-doc
   cleanup. Update navigation only when guide structure changes.
5. Run the relevant docs-site checks from `docs-site/package.json` and report
   changed guides, source evidence, and any unverified screenshots or claims.

Do not restore deleted app paths, generate fixed inventory tables, clear unrelated
agent state, or publish the site without authorization.
