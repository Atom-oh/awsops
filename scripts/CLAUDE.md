# Scripts

## Role
Deployment/ops automation behind the Makefile targets (`v2/`), plus the PR review panel
(`pr-review/`). Node deps live in `scripts/v2/package.json` (pg, @inquirer/prompts,
secrets-manager) — installed by `make deps`.

## Key Files
- `v2/configure.mjs` — `make configure`: interactive TUI → `terraform.tfvars` + `backend.hcl`.
  AWS access shells out to the `aws` CLI, not the SDK.
- `v2/deploy.mjs` — `make deploy` (runs migrate first): arm64 build → ECR push →
  ECS force-new-deployment → wait stable → smoke `/api/health`. The `DOCKER` env defaults to
  `sudo docker`.
- `v2/workers.mjs` — `make workers`: builds and pushes the worker image **only**. The Fargate
  worker is not an ECS service — SFN `RunTask` pulls `:worker-latest` at job time. Short jobs
  deploy as Lambda zips and need no image. Run after applying with `workers_enabled=true`.
- `v2/migrate.mjs` + `migrate-core.mjs` — `make migrate`: advisory-lock, checksum, stamps the
  release version from the `-- since:` header. `DRY_RUN=1` previews; `--status` gives an
  offline summary. Credentials come from `terraform output aurora_secret_arn` → Secrets
  Manager (collision-free, fail-loud migration runner).
- `v2/agentcore.mjs` + `agentcore/` — `make agentcore`: arm64 agent image + idempotent
  provisioner, writes to SSM.
- `v2/*.itest.mjs` — migration integration tests against a disposable PostgreSQL 17 container.
- `v2/upgrade.sh` — `make upgrade`: RDS snapshot → migrate → deploy. Previews unless
  `CONFIRM=go`.
- `pr-review/` — lens×model review panel: `run-panel.sh` requires exactly the named prompts
  `L2.txt`–`L5.txt` (other files ignored). All 12 model/lens reports must complete.
  `run-panel.sh` creates a fresh 32-hex nonce per cell/run and requires a final physical line
  `REVIEW_COMPLETE: <lens> <nonce> {"report":"JSON-escaped Markdown"}`. The stdlib
  `report_frame.py` counts only frames carrying this cell's expected nonce, then
  validates exactly one final frame, its lens and a nonblank report string. Earlier
  other-nonce frames are opaque chatter and receive no credit; an other-nonce frame
  after the current frame still makes it nonfinal. Duplicate expected-nonce frames,
  same-nonce wrong lenses, duplicate keys and malformed output fail closed.
  Kiro's assistant prefix and one numeric usage/time footer are cosmetic only.
  No tool-header, Markdown-fence or static-marker inference establishes completion.
  `lib.sh` revalidates the original frame before accepting only the decoded report,
  then strips controls and scrubs credentials, including escaped controls/session tokens.
  Rejected previews retain bounded scrubbed chatter and hide encoded frame payloads.
  Nonzero/timed-out CLI output is discarded; bounded retries and hard-kill backstops remain.
  `synthesize.sh` requires a successful chair CLI and both scrubbers, with a report body
  and a unique final verdict. The workflow ceiling is 90 minutes.
  - Kiro cells run with `--agent pr-review-readonly` (`agents/pr-review-readonly.json`:
    `tools` = `allowedTools` = `read`, `grep`; no MCP/resources/hooks), copied into the cell cwd's
    `.kiro/agents/` at run time. `--trust-tools=…` is gone — kiro-cli 2.11.1 ignores unknown names
    (empty value, stale `fs_read`) with a warning, so it never pinned the grant. Do not use
    `--v3`/`--mode default`: the v3 engine ignores an agent's `tools` list. Unlike the sibling
    repos this is a read-only agent, not `tools: []` — Kiro reads `$DIFF` from a file path and the
    base checkout by design.
  - Non-transient Kiro failures are detected on Kiro stderr only and are not retried: agent
    fallback (`no agent with name … Falling back`, rc=0) discards the response and forces FAIL via
    `kiro-agent-fallback.flag`; monthly quota (`Monthly request limit reached` / v3 JSON
    `MONTHLY_REQUEST_COUNT`, rc=0 + empty stdout) writes `kiro-quota.flag`. A per-model no-diff
    preflight (`PONG`) must pass for both models before any Kiro cell receives PR input
    (`kiro-preflight.flag` otherwise). `synthesize.sh` renders the three banners; see
    `docs/runbooks/pr-review-panel.md`. `run-panel.sh` logs `kiro-cli --version` first.
  - `preflight-aws-session.py` runs before panel and chair using the installed AWS CLI:
    `configure list` must select `container-role`, then signed `sts get-caller-identity`
    must succeed. It checks the existing EKS Pod Identity without changing SDK/provider,
    profile or signing settings. Each model CLI retains ambient SDK refresh.
  - Offline regressions: `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v`.
    Also run by `bash tests/run-all.sh` and a dedicated `merge-verify.yml` step.
  - **The chair call MUST pass `--strict-mcp-config`.** A user-scope MCP server (e.g. github)
    loads at session init; if its auth is broken, `claude -p` waits silently for the tool until
    `CHAIR_TIMEOUT` (currently 900s) with no error — killing both primary and fallback chairs
    and failing the gate regardless of the diff (observed: PR #194/#197/#202/#203).
    `--allowedTools` is a permission allowlist and does not stop MCP loading, so it is not a
    substitute.

## Migration Filename Rule
- `terraform/v2/foundation/migrations/<ULID>_<snake_name>.sql`
- ULID = 26-char Crockford base32 — **no I, L, O, U** (`/^[0-9A-HJKMNP-TV-Z]{26}$/i`).
  Hand-numbered (integer) ids are rejected by the runner; only ULID filenames are accepted.
- Duplicate ids fail loud before connecting; sort order is lexical (which is also time order
  for ULIDs).

## Rules
- Scripts assume they run from the repo root (they resolve resource addresses via
  `terraform -chdir=terraform/v2/foundation output`) — prefer the Makefile targets over running
  scripts directly.
- For the emergency IAM `put-role-policy` convention, see `terraform/CLAUDE.md`.
