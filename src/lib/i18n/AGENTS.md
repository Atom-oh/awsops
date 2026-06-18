<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 2031ac79d6e2 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# i18n module (v1 — `src/`)

Korean/English internationalization for the v1 app. Pattern: **React Context + localStorage** — deliberately **no URL-based locale routing** (avoids `/awsops` basePath conflicts). This is a v1 (`src/`) module; v2 (`web/`, `terraform/v2/`) does not use it.

## Shape
- A `LanguageProvider` + `useLanguage()` hook exposes `lang`, `setLang`, and a `t()` lookup function.
- Translation strings live in two parallel JSON dictionaries: `en.json` and `ko.json`.
- Consumers call `t('some.key')`; parameterized strings use `t('key', { count: 5 })`.

## Conventions a reviewer must enforce
- **Default locale is Korean (`ko`).** Toggle is the EN/한 control in the sidebar.
- **Key parity is mandatory:** every key added to `en.json` MUST also exist in `ko.json` (and vice versa). New pages/components must register all their strings in both dictionaries — a key present in only one file is a defect.
- Use the `t()` function for user-facing strings; avoid hard-coded literals in components.
- AI/agent responses should honor the active locale (pass the `lang` setting through), so localization isn't limited to static UI.

## Boundaries / gotchas
- This is presentation-layer locale state only — keep data-fetching, query, and config logic out of here (that belongs in the broader `src/lib` modules).
- Do not introduce URL/path-based locale switching; the Context + localStorage approach is intentional.
- Persistence is localStorage, so locale is client-side and per-browser — not a server/session concern.
