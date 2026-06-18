<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: f94a0e00ae5d · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# Contexts Module

App-wide React Context providers holding state shared across client components. This is **v1 (`src/`)** code — the legacy CDK/EC2 app served under the `/awsops` basePath. v1 rules (notably the `/awsops` fetch prefix) do **not** apply to v2 (`web/`, `terraform/v2/`), which serves at root.

## What lives here
- React Context providers only — app-wide client state, not page logic or data-fetching utilities.
- Primary file: `AccountContext.tsx` — multi-account provider exposing the selected account, accounts list, and merged feature flags, plus a `refetchAccounts()` method pages call after add/remove. An `ALL_ACCOUNTS` (`'__all__'`) sentinel is shared with the AccountSelector; in "All Accounts" mode feature flags are the **union** across accounts.

## Conventions a reviewer must enforce
- Every file in this module starts with the `'use client'` directive.
- Provider components are the **default export**; hooks are **named exports** (e.g. `export function useAccountContext()`). Don't mix these up.
- All fetch URLs use the **`/awsops/api/*` prefix** (v1 basePath). A bare `/api/*` here is a bug.
- Context value is memoized with `useMemo` — adding fields without keeping memoization stable causes needless re-renders of the whole tree.
- `localStorage` access (selected-account persistence) must stay wrapped in try/catch — SSR / disabled-storage environments throw otherwise.

## Gotchas
- "All Accounts" feature-flag merge is a union, not an intersection — review flag logic against that intent.
- This is a global provider mounted high in the tree; new context fields are cheap to add but expensive to invalidate. Prefer deriving in consumers over widening the context value.
