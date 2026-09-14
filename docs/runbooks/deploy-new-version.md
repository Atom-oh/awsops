# Deploy a v2 release

Use this runbook for operator-authorized releases from a reviewed commit. It replaces
the retired EC2/CDK startup procedure; v1 recovery evidence remains in git history.

## Before deployment

Confirm the intended repository, branch, commit, AWS account and Terraform backend.
Required CI and latest-HEAD AI review must be complete, with no unresolved
Critical/Major findings. Check migrations and the changed deployment surfaces below.
A docs-only change does not itself require an ECS or Terraform deployment.

For an origin web release through GitHub Actions, use the
[production Actions runbook](production-actions.md). Its default `check` mode
performs read-only validation; `deploy` requires the reviewed current main
snapshot, migration completion, exact running-image verification and
authenticated smoke checks. The manual commands below remain operator entry
points for the other release surfaces and recovery.

```bash
git status --short
git rev-parse HEAD
aws sts get-caller-identity
make help
```

Private Terraform root: `terraform/v2/foundation/`. Do not substitute the public
sample's `terraform/foundation/` path. Generated backend/tfvars contain environment
configuration and remain untracked. Do not dump credentials into logs.

`make migrate` validates the committed RDS certificate chain and hostname. A
missing/malformed trust bundle fails closed. The optional
[private CI executor](private-ci-migrations.md) exports the reviewed commit's
inputs and runs migrations inside Fargate. The designed path keeps DB passwords
inside the task; the access contract documents the controller credential holder's
broader [residual authority](../reference/github-actions-access.md#optional-private-migration-authority).

## Release boundaries

| Changed surface | Release operation |
| --- | --- |
| Web application | `make deploy`: migrations -> arm64 image build/ECR push -> ECS rollout -> wait stable -> `/api/health` smoke |
| Agent Runtime/provisioner | After required Terraform apply and `make migrate`, run `make agentcore`; use `SMOKE=1` when invocation verification is required |
| MCP Lambda code or infrastructure | Review and apply the exact saved Terraform plan; `make agentcore` does not publish Lambda code |
| Fargate workers | Worker infrastructure must exist; `make workers` builds and publishes its arm64 image |
| Schema | Add an immutable ULID migration; `make migrate` applies pending migrations and synchronizes the SQL-reader password |

For infrastructure changes:

```bash
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out tfplan
# After review, the controller executes:
terraform -chdir=terraform/v2/foundation apply tfplan
```

Do not use `-auto-approve` on shared infrastructure. Review replacement/deletion and
feature gates; leave attached SG descriptions unchanged. A default-off feature is
not permission to enable a frozen path.

Ordering is change-dependent. A new consumer must not start before its required
migration. If Terraform publishes a Lambda that immediately requires new columns,
apply the migration before that Lambda update; see the
[inventory runbook](steampipe-quota-and-staleness.md). Fresh SQL-reader setup needs
Terraform-created secrets, then `make migrate`, then `make agentcore`.

Run Make targets from the repository root. Build scripts default to `sudo docker`;
set `DOCKER=docker` when using a Docker-capable session without sudo. Web
`IMAGE_TAG` defaults to `web-latest` and must match the deployed task definition's
`image_tag`. `make deploy` forces a new deployment of that task definition; it does
not register a different image tag. Likewise, `WORKER_IMAGE_TAG` defaults to
`worker-latest` and must match `worker_image_tag` for on-demand Fargate jobs.

## Verification and recovery

Confirm ECS reaches stable state and the health smoke succeeds. Verify the affected
authenticated page/API and worker/agent path; `/api/health` alone does not establish
end-to-end function or data freshness. Record commit, image digest, applied migration
and observed result. Do not claim deployment from a successful build alone.

For rollback, select the previously verified image/task configuration and follow
its recorded deployment procedure. Check schema compatibility first; immutable
migrations are not undone by rolling back an image. Avoid an ad-hoc checkout/reset
in a shared working tree. `make upgrade` previews unless explicitly confirmed and
provides its own snapshot/migration flow.

Sources: `Makefile`, `scripts/v2/deploy.mjs`, `scripts/v2/upgrade.sh`,
[ADR-001](../decisions/001-v2-foundation.md),
[ADR-009](../decisions/009-async-worker-backbone.md).
