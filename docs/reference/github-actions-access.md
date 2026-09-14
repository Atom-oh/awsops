# GitHub Actions access bootstrap

The optional `github_actions_release` Terraform module prepares operator access
for `Atom-oh/awsops`. The core module provides IAM and verifier-secret metadata.
The separately configured `github_actions_migration` module adds a private
migration executor and its scoped task permissions. Release workflows remain
separate consumers. Neither module grants product/agent remediation authority
or changes ADR-005.

`github_actions_enabled` defaults to `false`. Enablement creates three managed
resources: the release IAM role, its inline policy, and Secrets Manager metadata
for a verifier. It also reads the existing GitHub OIDC provider. It does not
manage that provider, create KMS keys, or put any credential value in Terraform.

Use the separate [deployment verifier bootstrap](../runbooks/deployment-verifier.md)
to populate the credential. Its non-admin Cognito user retains standard dashboard
session authority, including billable chat/diagnosis/worker operations. A secret
reader can exercise that authority; fixed read-only probe requests do not make
the account read-only. The runbook specifies reader/writer restrictions,
serialization and coordinated recovery.

## Trust and existing provider

Bootstrap looks up the account's existing
`token.actions.githubusercontent.com` provider and requires its exact issuer URL
and the `sts.amazonaws.com` audience. A missing/unreadable provider or missing
STS audience blocks bootstrap. The bootstrap operator needs permission to read
that provider; the new release role receives no IAM management permission.

The role trusts only audience `sts.amazonaws.com` and subject
`repo:Atom-oh/awsops:environment:production`. The environment subject does not
itself bind a branch. Before enablement, the repository owner must restrict the
`production` environment to `main`. The operator's manual release dispatch and
latest-HEAD review/CI procedure govern deployment; additional environment
reviewers are an explicit team choice. These GitHub settings are not managed
by this Terraform module.

**Dated deployment decision — 2026-09-14:** this operator-authorized CI work uses
an explicit production `workflow_dispatch` against reviewed `main`, with the
latest-HEAD AI-review/fix/CI/merge procedure as its source gate. A second
environment-reviewer approval is not configured, avoiding a duplicate approval
step after an authorized deployment request. This does not authorize unattended
production pushes or arbitrary future dispatches: each production release still
needs operator authorization, and changing that operating model requires its
own review. The environment must remain restricted to `main`; repository and
environment administrators are trusted deployment principals. The stronger
database authority added by private migrations is accepted for this operator
deployment purpose and is explicitly described below; it is not a product
autonomy exception.

## Permission surface and limits

The role has no S3 or Terraform-state access. A state object's read permission
would expose its edge HMAC key and generated passwords, not merely the selected
outputs. Release consumers must use independently supplied identifiers and
scoped service APIs instead of `terraform output` under this role.

- ECR authentication has a regional condition. Image read/push and
  `DescribeRepositories` name only `<project>-web`.
- ECS service operations name only `<project>/<project>-web`; task descriptions
  and task listing stay within the project cluster. Listing also has a region
  condition. `DescribeTaskDefinition` is region-scoped with `Resource: "*"`
  because that API does not support resource-level IAM scoping. Task-definition
  responses can contain plaintext environment configuration; consumers must use
  an explicit safe projection, not publish the full response. The owned web task
  definition's `APP_DOMAIN` can support a consumer's expected-URL comparison.
- `rds:DescribeDBClusters` names only the regional `<project>-aurora` cluster.
  It supports endpoint and master-secret-ARN discovery without reading a password.
- Secrets Manager Get/Describe access names the verifier secret plus only the
  explicitly supplied optional migration secret ARNs. An empty migration list
  grants no existing Aurora master/reader credential access.
- The core module adds no CloudFront API, task execution, IAM editing, AgentCore
  provisioning or infrastructure apply. The optional private migration attachment
  adds the task registration/execution and two-role PassRole surface below.

**Residual UpdateService authority:** IAM restricts the service target, not the
operation to `forceNewDeployment`. Changes to desired count, network configuration
and other permitted deployment fields remain possible. A consumer's restart-only
checks do not narrow this IAM authority. Review that residual privilege when
approving the role. ECR publication plus service updates also permits arbitrary
image code under the existing web task role; a restart-only consumer does not
remove that residual authority.

## Optional private migration authority

`github_actions_migration=null` creates nothing. A non-null configuration creates
the dedicated roles/policies and log group independently; attachment to the web
CI role additionally requires `github_actions_enabled=true`. It grants:

- `RegisterTaskDefinition` and `RunTask` only for the project migration family,
  with launch restricted to the project cluster and required Project/Purpose tags.
- `iam:PassRole` only for the two dedicated migration roles, to ECS tasks.
- Read-only task discovery in the cluster. `StopTask` additionally requires the
  project's `Purpose=ci-migration` tags. The controller checks the exact nonce,
  definition and task ARN; IAM permits cleanup of other tagged migration tasks,
  but not untagged web, inventory or worker tasks.
- Task tags only as part of `RunTask`; the CI role cannot retag an existing
  application task to obtain stop permission.

The current action-specific [ECS Service Authorization Reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html#list_ecs-action-RegisterTaskDefinition)
lists a required `task-definition` resource for `RegisterTaskDefinition`.
The same service's `DescribeTaskDefinition` and `DeregisterTaskDefinition` actions
do not support that scope. Generic task-definition examples using `Resource:"*"`
do not override the current per-action table; this module keeps family scoping.

**Residual executor authority:** ECR image publication, task registration,
PassRole and RunTask together permit arbitrary code inside the approved private
network with the migration task's database-master secret access. The controller's
fixed command, count and resource settings are code restrictions, not an IAM
guarantee against a compromised credential holder using supported overrides.
Main review, explicit operator deployment and environment access govern this
database-administration authority. This is external operator CI, not a
product-reachable remediation/autonomy path. See the
[private executor runbook](../runbooks/private-ci-migrations.md).

`github_actions_secret_kms_key_arns` defaults to an empty list. Existing key ARNs
add only `kms:Decrypt` on those keys, restricted by `aws:RequestedRegion`,
`kms:ViaService=secretsmanager.<region>.amazonaws.com`, and the exact approved
migration/verifier secret ARNs in `kms:EncryptionContext:SecretARN`. Empty inputs
add no KMS permission. The existing key policy must also permit this use; the
module does not manage keys, key policies, grants or secret rotation.

## Bootstrap inputs

Use the existing trusted production operator configuration for
`terraform/v2/foundation`. Persist the opt-in so a later normal plan does not
remove the CI resources. A release-only role needs no migration credentials:

```hcl
github_actions_enabled               = true
github_actions_migration_secret_arns = []
github_actions_secret_kms_key_arns   = []
```

When using the private Fargate executor, keep
`github_actions_migration_secret_arns=[]` on the CI role. Supply database secret
and key metadata through `github_actions_migration`; only the dedicated task role
gets those credentials. The legacy direct-secret inputs remain available only
for a separately reviewed direct executor with verified private connectivity;
they are not prerequisites for the Fargate path. Omit the reader identifier when
that capability is disabled. Do not grant a master credential without a consumer.

For approved secrets using customer-managed keys, resolve identifiers using the
existing operator's metadata-read permissions:

```bash
aws secretsmanager describe-secret \
  --region "<REGION>" --secret-id "<APPROVED_SECRET_ARN>" \
  --query '{SecretARN:ARN,KmsKeyId:KmsKeyId}' --output json

aws kms describe-key \
  --region "<REGION>" --key-id "<KMS_KEY_ID_OR_ALIAS_ARN_FROM_DESCRIBE_SECRET>" \
  --query 'KeyMetadata.{Arn:Arn,KeyManager:KeyManager}' --output json
```

These commands return identifiers and key metadata, not secret values. Supply
unique `KeyMetadata.Arn` values for the approved customer-managed keys in
`github_actions_secret_kms_key_arns`. The module accepts full key ARNs in the same
account/region and rejects aliases, bare IDs and wildcards. `DescribeKey` is an
operator lookup permission, not an added release-role permission. If
`DescribeSecret` omits `KmsKeyId`, the secret uses `aws/secretsmanager` and needs
no key entry. This foundation's master secret uses a customer-managed Aurora key;
include that key only when master-secret access is actually required and granted.

References: [DescribeSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DescribeSecret.html),
[DescribeKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_DescribeKey.html),
and [Secrets Manager encryption](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html).

Prepare the saved bootstrap plan privately (`umask 077`). A targeted bootstrap
can use `-target=module.github_actions_release`; inspect it and stop on unexpected
managed-resource changes. The trusted bootstrap operator applies the reviewed
saved plan without `-auto-approve`. Never publish raw plans or state. This
operator's state access is not delegated to the CI role.

Outputs remain `github_actions_release_role_arn` and
`github_actions_smoke_secret_arn`. Populate verifier credentials separately for
an identified consumer, using a dedicated non-admin identity. Suppress machine
identity invitation messages and preserve working credentials on reruns; a
missing secret value does not authorize resetting an existing user. No identity
provisioning or secret-population automation is shipped by this module.

## Offline verification and handoff

From the repository root, use Terraform 1.15.7 with backend-free initialization
and the mocked-provider test filter:

```bash
terraform -chdir=terraform/v2/foundation init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform/v2/foundation test -filter=tests/github_actions_release.tftest.hcl
```

Tests cover the default-off plan, existing-provider lookup and audience checks,
exact trust, absent state/CloudFront access, release-only empty migration grants,
scoped discovery, conditional KMS access, and rejected foreign/wildcard inputs.
Offline tests establish the policy contract, not live deployment or connectivity.
Before using the role, a separately reviewed consumer must demonstrate OIDC
assumption, independent target identity/URL binding, safe response handling, and
any required private migration execution. No workflow `check` or `deploy` mode is
provided or claimed by this bootstrap reference.
