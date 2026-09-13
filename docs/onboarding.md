# Developer onboarding

Read [project context](../CLAUDE.md) and the [decision baseline](decisions/BASELINE.md).
In this origin checkout, Terraform lives at `terraform/v2/foundation/`.

## Local setup

Use Node.js 20, Python with the relevant requirements, and Docker for disposable
PostgreSQL integration tests. Match Terraform's version constraint in
`terraform/v2/foundation/backend.tf` when working on infrastructure.

```bash
npm ci --prefix web
cp web/.env.example web/.env.local
(cd web && npm run dev)
```

Fill only the required local configuration; do not commit credentials or environment
files. Database-backed routes need network access to Aurora and AWS credentials
authorized for IAM DB login as `awsops_web`; an endpoint alone is insufficient.
Without `AURORA_ENDPOINT`, `/api/db` returns 503 `unconfigured`, not an empty
production dataset. Production uses ECS task configuration and managed secrets.
App paths start at `/`; API requests use `/api/*`.

## Verification

Run from the repository root:

```bash
(cd web && npx vitest run)
(cd web && npm run build)
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v
bash scripts/v2/merge-verify.sh
```

The merge runner isolates Python files and runs web Vitest. Its Terraform checks
are opportunistic, not a substitute for validation/plan review. Local hook/structure
checks use `bash tests/run-all.sh`; database integration tests are
`scripts/v2/*.itest.mjs`. See [verification](v2-merge-verification.md).

## Infrastructure and deployment

```bash
make configure
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out tfplan
```

Review the saved plan before the controller applies it. Do not use `-auto-approve`
on shared infrastructure. Keep generated tfvars/backend settings untracked.
Default-off optional features still require explicit configuration; a new foundation
plan creates resources and may incur cost.

Use [deploy-new-version.md](runbooks/deploy-new-version.md) for web, agent, worker and
MCP Lambda release boundaries. `make deploy` runs migrations before the web rollout.
`make agentcore` requires both Terraform apply and `make migrate` beforehand.
`make help` lists supported targets.

Historical EC2/Steampipe startup scripts and CDK runbooks are not v2 setup steps.
[Documentation map](README.md) separates current references from historical records.
