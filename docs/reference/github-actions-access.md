# GitHub Actions access bootstrap

The optional `github_actions_release` Terraform module prepares operator access
for `Atom-oh/awsops`. This change is bootstrap-only: it provides IAM and verifier
secret metadata, not a release workflow, migration executor, or deployment
verification modes. Consumers require separate implementation and review. It
does not grant product/agent remediation authority or change ADR-005.

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
`production` environment to `main` and configure its required reviewers.
Those GitHub protection settings are operator prerequisites, not resources
managed by this module.

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
- No CloudFront API, `iam:PassRole`, task execution, IAM editing, AgentCore
  provisioning or infrastructure-apply permission is added.

**Residual UpdateService authority:** IAM restricts the service target, not the
operation to `forceNewDeployment`. Changes to desired count, network configuration
and other permitted deployment fields remain possible. A consumer's restart-only
checks do not narrow this IAM authority. Review that residual privilege when
approving the role; absence of `iam:PassRole` does not make it restart-only.

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

Add migration secret ARNs only after identifying a reviewed executor that can
reach private Aurora, including its network path and verified-TLS authentication.
Possessing a master-secret ARN or password does not make a GitHub-hosted runner
able to connect. This bootstrap supplies neither that executor nor network access.
The optional SQL-reader secret is a separate explicit identifier; omit it when
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
