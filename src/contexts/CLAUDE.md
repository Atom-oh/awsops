# Contexts Module

## Role
React Context providers for app-wide state shared across client components.

## Key Files (1)
- `AccountContext.tsx` -- Multi-account context provider
  - `AccountProvider` (default export): wraps app with account state
  - `useAccountContext()` (named export): hook returning current account, accounts list, feature flags
  - `ALL_ACCOUNTS` (named export): the `'__all__'` sentinel constant, shared with AccountSelector
  - Fetches account list from `/awsops/api/steampipe?action=config` on mount via `refetchAccounts()`
  - `refetchAccounts()`: re-fetches account list from config API; also exposed in context for pages (e.g., accounts page) to call after add/remove
  - Persists selected account in `localStorage` (`awsops_current_account` key) with try/catch protection
  - `getFeatures()`: returns merged feature flags; in "All Accounts" mode, returns union of all account features
  - Context value is memoized via `useMemo` to prevent unnecessary re-renders

## Rules
- All context files use `'use client'` directive
- Provider components use `export default`
- Hook functions use named exports (`export function useAccountContext()`)
- All fetch URLs must use `/awsops/api/*` prefix

---

# Contexts Module (Korean)

## Role
- App-wide React Context
- `AccountContext.tsx`: AccountProvider (default) + useAccountContext (named) + ALL_ACCOUNTS (named)
- `refetchAccounts()` 메서드 추가 — 계정 추가/삭제 후 컨텍스트 갱신
- localStorage try/catch 보호
- 컨텍스트 값 useMemo로 메모이제이션
- `/awsops/api/steampipe?action=config`
