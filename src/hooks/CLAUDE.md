# Hooks Module

## Role
Custom React hooks. Currently empty — pages use `useAccountContext()` from `@/contexts/AccountContext` directly.

## Rules
- All hooks use `'use client'` directive
- Named exports (`export function useXxx()`)
- All fetch URLs must use `/awsops/api/*` prefix
