# Integration Workflows Implementation Plan

**Goal:** Make external evidence, customization and report handoff usable without
misrepresenting connection or delivery status.

**Architecture:** Extend the existing BFF, provider Lambda and React flows.
Keep saved credentials server-side. Generate report drafts from authorized
artifacts with bounded redaction; users explicitly transfer them.

**Tech stack:** Next.js 14, TypeScript, Vitest, Python, pytest, Playwright.

**Spec:** [Integration workflow design](../specs/2026-09-13-integration-workflows-design.md).

## Tasks

- [x] Connection test: reproduce saved-credential, endpoint-override and stale
  result defects in `web/app/api/datasources/test/route.test.ts` and
  `web/app/integrations/datasources/DatasourceForm.test.tsx`. Fix those routes and
  form; verify changed endpoint, malformed input, secret-bearing errors and
  provider-specific defaults. Reuse instance credentials or an exact-endpoint
  default mirror under the legacy migration rules.
- [x] Datasource list: fix default-implies-connected and silent failure behavior
  in `web/app/api/datasources/route.ts` and `DatasourcesTab.tsx`; keep endpoint
  visibility admin-only. Verify non-admin, empty, unavailable and failed actions.
- [x] Provider probes: make Datadog test both API and application credentials.
  Use offline Python tests for valid, invalid, missing and rejected credentials.
- [x] Customization: follow existing agent/skill registration through validation,
  enablement, account assignment and resolver consumption. Repair demonstrated
  failures with focused tests; preserve catalog/tool boundaries.
- [x] Report handoff: add `web/lib/report-handoff.ts`, authorized report response
  fields and a preview/copy/download component. Verify ownership, redaction,
  bounded output, coverage caveats, stale selection and clipboard failures.
- [x] Hub: explain evidence sources, knowledge/report destinations and agent
  customization with usable navigation. Show stored/unknown/restricted connector
  states, manual handoff availability and gated remote-MCP status accurately.
- [ ] Verification: run relevant Vitest/Python suites, production build, desktop
  and mobile Playwright interactions, and repository structure checks.
- [ ] Integration: create reviewable PRs, resolve verified Critical/Major
  findings, obtain complete latest-HEAD AI coverage, pass required CI and merge.

No task authorizes live SaaS messages, infrastructure deployment or gate changes.
