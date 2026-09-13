# Build and Deploy

Follow root `CLAUDE.md`, `docs/decisions/BASELINE.md`, and the user's deployment
scope. The entry points are the root `Makefile` and `scripts/v2/`.

1. Verify the branch/worktree and target environment. Run relevant tests and
   `npm ci && npm run build` in `web/`. There is no lint script.
2. For an authorized web deployment, run `make deploy` from the repository root.
   It applies pending migrations, builds arm64, pushes ECR, rolls ECS, waits for
   stability, and checks `/api/health`. Stop on failure.
3. Agent deployment uses `make agentcore` after `make migrate` and the required
   Terraform changes. MCP Lambda source is deployed through Terraform.
   `make workers` builds/pushes the Fargate worker image; workers are launched
   on demand.
4. Shared infrastructure uses `terraform/v2/foundation/`: save a plan and have the
   controller apply that plan. Never use `-auto-approve`.

Report the deployed revision, checks, and any failed or skipped stage.
These operational commands do not authorize enabling a FROZEN product capability.
