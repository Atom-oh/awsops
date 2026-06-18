<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: c9324456903c · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# Accounts Module (v1 `src/`)

## What this is
Multi-account management page (`page.tsx`) — add/remove/test AWS accounts, with Host-account auto-detection. Admin-only.

## Scope note (v1 vs v2)
This lives under `src/` — the **v1 (CDK/EC2/Steampipe)** app. v1 rules apply here, NOT v2 (`web/`, `terraform/v2/`). Notably the **`/awsops/api/*` fetch prefix is mandatory** in v1; v2 uses root `/api/*`. Do not flag v1 conventions against v2 rules.

## Access control (a reviewer must enforce)
- Gated by the `adminEmails` config. Only listed emails get in.
- Non-admin users see an "Access Denied" screen (Shield icon).
- **The API must enforce the same gate, not just the UI** — `add-account`, `remove-account`, `init-host` all return 403 for non-admins. UI-only gating is a security bug.

## Conventions / banned-patterns
- Adding an account requires a **Steampipe restart** to take effect.
- Input validation:
  - Alias: letters/digits/space/hyphen/underscore, max 64 chars.
  - Region: must match `^[a-z]{2}-[a-z]+-\d$`.
- Rate limit: 5 requests/user/minute on the mutating endpoints.

## Review focus
Confirm admin checks are server-side (403 path) on every mutating action; validate alias/region inputs against the patterns above; preserve the rate limit; and don't drop the post-add Steampipe restart.
