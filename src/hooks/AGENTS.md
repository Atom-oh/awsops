<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: a7f56427c4d0 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# Hooks Module (v1 `src/`)

Custom React hooks for the **v1 legacy app** (`src/`, CDK/EC2/Steampipe). Effectively empty today — pages consume `useAccountContext()` from `@/contexts/AccountContext` directly rather than via a wrapper hook.

## Conventions a reviewer must enforce
- Every hook starts with the `'use client'` directive.
- Use **named exports** (`export function useXxx()`), not default exports.
- All fetch URLs MUST carry the `/awsops/api/*` prefix (v1 basePath convention).

## Scope boundary
- This is **v1 only**. The `/awsops` fetch prefix is a v1 rule and does **not** apply to v2 (`web/`, `terraform/v2/`), where routes are served at root (`/api/*`). Do not flag a missing `/awsops` prefix in v2 code, and do not import v2 patterns here.
