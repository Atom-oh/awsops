# Production web releases through GitHub Actions

The `Production Web Release` workflow is a manual `origin/main` entry point.
It uses the `production` environment, which must allow only the `main` branch.
The request guard rejects other repositories, refs, events and operations.

The source guard requires a merged main PR, successful checks from the actual
review/merge-verification workflow runs, a trusted review bound to that PR HEAD,
every configured specialist, explicit complete semantic coverage, and no active
blocking review. It rechecks main before production writes. A review or CI run
still in progress is not a successful release prerequisite.

Before merging a production candidate, update its branch to the intended main
base and repeat latest-HEAD review/CI. Use a merge commit: the guard requires
exactly two parents, the reviewed HEAD as second parent, and an identical tree.
Squash/rebase merges and a combined tree changed by an intervening main update
do not satisfy this release contract.

## One-time configuration

Provision the default-off [scoped release access](../reference/github-actions-access.md)
through a reviewed saved operator plan. Keep
`github_actions_migration_secret_arns=[]` on the web role. Provision the separate
[private migration executor](private-ci-migrations.md) with existing private
subnets and the web service security group. Only that Fargate task receives
master-secret/CMK access. The `awsops-claude-arm` runner needs AWS API access;
it does not need a network route to Aurora or access to its password.

Create the non-admin [deployment verifier](deployment-verifier.md) and store its
value in the provisioned Secrets Manager secret. Do not place application
passwords in Actions variables or environment configuration.

Configure these **metadata-only** repository or production-environment variables:

| Variable | Source |
| --- | --- |
| `AWSOPS_ACCOUNT_ID` | Independently verified production account |
| `AWSOPS_REGION` | Foundation region |
| `AWSOPS_PROJECT` | Foundation project |
| `AWSOPS_PUBLIC_URL` | HTTPS service origin; must match the existing web task's `APP_DOMAIN` |
| `AWSOPS_CLOUDFRONT_DOMAIN` | Optional owned distribution `DomainName`, verified by an operator to carry the service alias; use when runner DNS cannot resolve the service domain |
| `AWSOPS_RELEASE_ROLE_ARN` | `github_actions_release_role_arn` |
| `AWSOPS_SMOKE_SECRET_ARN` | `github_actions_smoke_secret_arn` |
| `AWSOPS_SQL_READER_SECRET_ARN` | Existing `agent_sql_reader_secret_arn`, or explicit `disabled` when that capability is absent |
| `AWSOPS_MIGRATION_CONFIG_JSON` | JSON value of `github_actions_migration_config` |

The web workflow does **not** receive Terraform state, a backend configuration,
or raw tfvars. It discovers the owned repository, ECS service/task definition
and Aurora metadata through scoped AWS reads. The release controller supplies
only commit/account/project-bound connection metadata to private Fargate.
Preflight compares that target with the executor's independently validated
configuration, including whether the SQL-reader secret is present or disabled.
`check-executor` repeats the comparison immediately before each preview/apply
task launch; a disagreement stops the workflow before migrations can run.
Credentials are fetched inside the task from Secrets Manager and are never
passed in task environment variables or stored in Actions.

The migration policy adds execution of the one migration task family and
PassRole for its two dedicated roles. It grants no AgentCore, IAM editing or
infrastructure apply. Image publication plus task execution is privileged
deployment authority; protect production environment and main merge access.

## Read-only check

```bash
gh workflow run deploy-web.yml -R Atom-oh/awsops --ref main -f mode=check
```

This verifies the source, real assumed account/role, owned resource identities,
the private migration metadata, then login, non-admin session identity, health,
DB, inventory-summary and diagnosis-read responses. It creates no image,
applies no migration and replaces no service. It does not claim a new commit
has been deployed.

To test the actual migration network and TLS connection without applying DDL:

```bash
gh workflow run deploy-web.yml -R Atom-oh/awsops --ref main -f mode=preview
```

Preview builds the current migration image and starts one private Fargate task.
It reads the database migration ledger over verified TLS and verifies the
matching stopped-task/digest/nonce receipt afterward. It does not apply
migrations, sync the reader password, promote the web image or replace a service.

## Deploy the selected main snapshot

```bash
gh workflow run deploy-web.yml -R Atom-oh/awsops --ref main -f mode=deploy
```

The run uses its immutable GitHub SHA. It:

1. Validates the reviewed source and independently checks the AWS target.
2. Builds Linux ARM64 web and migration images and binds the registry digests to the run.
3. Refreshes credentials and rechecks the source before applying migrations.
4. Applies migrations in private Fargate over verified TLS. A matching
   stopped task, digest, successful exit and nonce-bound success log are required
   before promoting the image.
5. Records the service's new deployment ID and requires that exact deployment
   to complete with healthy tasks running the built digest.
6. Performs mandatory authenticated application/DB smoke checks.

An ECS rollback to another image is a failed release, even if the service
becomes healthy again. A changed source, service, tag or image also fails.
Private manifests and verifier credentials are cleaned on success or failure;
credentials and raw Terraform state are not uploaded as artifacts.

If the runner cannot resolve the service alias, the optional CloudFront domain
changes only the DNS/TCP destination. The original service URL remains the HTTP
Host, TLS SNI/certificate hostname, cookie domain and redirect boundary. The edge
path remains CloudFront; certificate verification is never disabled. When this
explicit route is used, ambient HTTP proxies are not used. A missing optional
variable preserves normal DNS resolution.
The promoted `web-latest` tag is not automatically restored after a failed
verification. Investigate a failure that reached rollout before re-dispatching:
workflow cleanup removes the per-run journals, so a new dispatch is a new release
attempt. Restoring a previous tag is an explicit operator recovery action subject
to schema compatibility; it does not undo applied migrations.

This workflow releases the current main snapshot. Older-image rollback remains
an explicit operator recovery operation with a schema-compatibility review;
immutable migrations are not undone by replacing an image.
