# Private CI migration executor

The CI runner cannot connect directly to the production Aurora subnet. The
default-off `github_actions_migration` module runs the reviewed migration code
as one ARM64 Fargate task using the existing private subnets and web service
security group. It changes no ingress rule. This is operator deployment
infrastructure, not an application remediation or autonomous mutation path.

## Provisioning

Set `github_actions_migration` to the existing subnet IDs, web service SG ID,
Aurora managed master-secret ARN, optional SQL reader secret ARN, and exact
Secrets Manager CMK ARNs. All are metadata, not secret values. Review a saved
Terraform plan and apply only that plan. Persist the configuration in the
operator's governed tfvars. Do not grant whole-state access or DB secret access
to the CI runner. Its existing `github_actions_migration_secret_arns` remains
empty.

The module creates dedicated task/execution roles, narrowly scoped policies
and one log group. It attaches the controller policy to the enabled web CI role.
The task role reads only the configured database secrets and decrypts only
their approved keys through Secrets Manager. The execution role pulls the
owned web ECR repository and writes only the migration log group. No new
network rule, application flag, secret value or database resource is created.

Copy the JSON `github_actions_migration_config` output to the protected
`AWSOPS_MIGRATION_CONFIG_JSON` GitHub production variable. This whitelisted
output contains no secret values; never export the whole state or all outputs.
The caller also needs its existing own-cluster `rds:DescribeDBClusters` and ECR
build/read permissions.

## Execution contract

From the repository root, run `python3 scripts/v2/ci_origin_migration.py prepare-build`.
It rejects untracked migration
inputs and exports the allowlisted files from `git archive <reviewed SHA>` into
the private receipt directory's `migration-build` child. Even gitignored SQL is
excluded. In Actions, `GITHUB_OUTPUT` receives the `context` path. Build the
Dockerfile inside that exported context for `linux/arm64`, passing `SOURCE_COMMIT`
equal to the reviewed source SHA. Do not build from the mutable checkout.
Use a single platform manifest (`provenance=false`, `sbom=false`) and publish
`migration-<SHA>`. The release workflow passes the build result digest directly
to `ci_origin_migration.py`; a tag alone cannot establish build provenance.

The controller verifies the actual assumed account/role, exact project Aurora
metadata and managed secret, then registers the fixed task with a digest image,
the two dedicated roles and nonsecret metadata. It launches one task with no
public IP, shell/SQL override or ECS Exec. The bundled image verifies its baked
source SHA, fetches credentials in process, confirms the live database target,
and invokes the normal immutable-checksum/advisory-lock migration runner over
validated RDS TLS.

Success requires the owned task to stop with exit zero, the exact running
image digest, and a structured success log bound to the source, operation and
random nonce. `python3 scripts/v2/ci_origin_migration.py verify --mode apply` rechecks the owned
database and running-task evidence before a consumer may promote an image.
Preview receipts never authorize an apply/release. Missing,
foreign or mismatched evidence fails closed. The private CloudWatch stream also
retains safe migration progress, stable row IDs from the report-schedule
deduplication, reader/hardening outcomes, and a failure class/file identifier.
User identities, arbitrary notices, raw SQL and driver/CLI errors are excluded.
Unrecognized notices are explicitly counted as redacted; new audit notice forms
need a safe projection before adopting them in CI. Failed runs mark row outcomes
unconfirmed and nontransactional partial-state metadata unknown when unavailable.
Do not treat a failed run's notices as proof that its transaction committed.

The image uses Node 22, and the required migration suites run on that same major.
The ledger must already use TEXT migration IDs. An INTEGER legacy ledger returns
`bootstrap_required`; its one-time `BOOTSTRAP=1 make migrate` remains an explicitly
authorized quiet-window operator action, not a CI override.

## Cleanup and residual authority

From the repository root, invoke `python3 scripts/v2/ci_origin_migration.py cleanup`
before deleting private workflow files. IAM permits
StopTask only for the project/Purpose-tagged CI migration tasks; task tagging is
permitted only at RunTask creation, not on existing web/worker/inventory tasks.
The controller additionally stops
only a task whose cluster, definition, nonce and task ARN match this run,
including discovery after a lost launch response. A cleanup timeout is an
operator follow-up, not successful completion.

Immutable task-definition revisions remain for audit; the CI role cannot
deregister arbitrary definitions. A runner outage before cleanup can leave a
task until the image's 15-minute execution bound terminates it. Inspect the
owned family in ECS when recovering from an interrupted run.

Publishing migration code and executing it under the dedicated task role is
database-administration authority. Main review/CI and production environment
protection govern that authority. This capability does not establish schema
compatibility for rolling back a web image; that remains a separate reviewed
operator decision. See the access contract's
[residual executor authority](../reference/github-actions-access.md#optional-private-migration-authority);
fixed controller parameters cannot narrow what stolen role credentials permit.
