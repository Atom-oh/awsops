# Scripts

Read root [CLAUDE.md](../CLAUDE.md) and
[BASELINE.md](../docs/decisions/BASELINE.md) for policy. Run operational entry
points from the repository root through the `Makefile`.

## Operational entry points

- `make deps` installs `scripts/v2/package.json` dependencies. `make configure`
  writes local config for `terraform/v2/foundation/`.
- `make deploy` runs migrations, builds/pushes the arm64 web image, rolls ECS,
  waits for stability, and checks `/api/health`.
- `make agentcore` builds/pushes the arm64 runtime and runs the idempotent
  provisioner. Run `make migrate` first; it creates/synchronizes the SQL reader.
  MCP Lambda changes ship through Terraform.
- `make workers` builds/pushes the Fargate worker image. Step Functions starts
  worker tasks on demand; there is no worker ECS service to restart.
- `make upgrade` previews unless `CONFIRM=go`. Follow existing operator
  authorization; shared Terraform applies belong to the controller.

## Migrations

`v2/migrate.mjs` and `migrate-core.mjs` enforce ULID filenames, checksums, and an
advisory lock. Add `terraform/v2/foundation/migrations/<ULID>_<name>.sql`; preserve
merged contents, including `-- since:` headers. `make migrate-status` is offline;
`DRY_RUN=1 make migrate` compares against the live ledger without applying SQL.
Migration integration tests (`v2/*.itest.mjs`) use disposable PostgreSQL containers.

`make backfill-owner-sub` only plans. Disable legacy email ownership only after a
successful apply confirms zero remaining legacy rows, per BASELINE.

## Review tooling

`pr-review/run-panel.sh`, `report_frame.py`, `lib.sh`, and `synthesize.sh` define
required review coverage and the completion protocol. Every required cell must
complete for the reviewed HEAD. Preserve nonce-bound final JSON report frames,
redaction, retry/time limits, and fail-closed coverage/chair validation.
`preflight-aws-session.py` checks ambient Pod Identity without changing providers
or signing settings. The chair retains `--strict-mcp-config`.

Offline checks: `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v`.
Read those tests for protocol details rather than copying model rosters or frame
examples into context docs. Never bypass required checks or expose full environments.
