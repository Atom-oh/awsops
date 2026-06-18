<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: a9839ad7e8ec · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# Components module (v1 `src/`)

Shared React components used across pages: layout shell, dashboard cards, Recharts wrappers, the generic data table, the diagnosis-report markdown renderer, and K9s-style EKS UI.

**Scope note:** this is the **v1** app (`src/`, CDK/EC2/Steampipe, `/awsops` basePath). It is the untouched legacy production app. v2 lives in `web/` + `terraform/v2/` and does NOT share these components or conventions — do not cross-apply v1 rules (e.g. `/awsops` prefix, navy/accent tokens) to v2 code or vice-versa.

## Architectural boundaries
- One flat inventory governs all subdirectories: subfolders are single-responsibility groups and intentionally have **no per-folder `CLAUDE.md`**. This file is the single source of truth.
- `layout/` — global shell (Sidebar, Header, AccountSelector). Every page renders through `layout.tsx`. Depends on next/navigation + AccountContext.
- `providers/` — client-side context tree; isolates the App Router `'use client'` boundary (LanguageProvider + AccountProvider).
- `dashboard/` — home cards (StatsCard, LiveResourceCard, CategoryCard, StatusBadge, AccountBadge).
- `charts/` — Recharts wrappers; all responsive charts go through `SafeResponsiveContainer`.
- `table/DataTable.tsx` — generic table (sorting, render fns); auto-adds an Account column in multi-account mode.
- `k8s/` — K9s-style EKS UI; used **only** from `src/app/k8s/explorer/`. Don't import it elsewhere.
- (root) — page-shared components with no group home (e.g. `ReportMarkdown.tsx`).

## Conventions a reviewer must enforce
- **Every component is `export default`.**
- Tailwind classes use theme tokens **`navy-*` / `accent-*`** (v1 palette) — flag raw/off-palette colors.
- **`color` props are name strings** (`'cyan' | 'green' | 'purple' | 'orange' | 'red' | 'pink'`), **never hex.** Reject hex color values in card/chart props.
- `StatusBadge` takes a `status` prop only — there is **no `text` prop**.
- Sign Out lives in the Sidebar next to the logo and calls `POST /api/auth`, which deletes the HttpOnly cookie **server-side** — don't clear auth client-side.

## Gotchas
- **SSR 0×0 chart bug:** Recharts `ResponsiveContainer` can render at 0×0 during SSR/hydration. Always use `SafeResponsiveContainer` (guards the bug + enforces a min height) rather than raw `ResponsiveContainer`.
- AccountSelector / Account column are conditional on multi-account mode — verify single-account rendering isn't broken when touching account-aware components.
