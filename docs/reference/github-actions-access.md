# Production web release access

The optional `github_actions_release` Terraform module grants operator release
access for `Atom-oh/awsops`. It does not grant product or agent remediation
authority and does not change ADR-005.

`github_actions_enabled` defaults to `false`. When enabled, the module creates
exactly three resources: a release IAM role, its inline policy, and Secrets
Manager metadata for a deployment verifier. It does not create or change the
account's GitHub OIDC provider and does not put a credential value in Terraform.

## Trust and permissions

The role trusts only the existing `token.actions.githubusercontent.com` provider,
audience `sts.amazonaws.com`, and subject
`repo:Atom-oh/awsops:environment:production`. Before enabling it, restrict the
repository's `production` environment to the `main` branch.

The role can publish images only to the project's web ECR repository, read the
specified backend state object, read the explicitly supplied migration secrets
and verifier secret, and update/read the project's web ECS service and tasks.
ECS task-definition reads and ECR authentication have regional conditions where
resource-level scoping is unavailable; task listing additionally requires the
project's cluster ARN. There is no `iam:PassRole`, task execution, IAM editing,
AgentCore provisioning or infrastructure-apply grant.

`github_actions_secret_kms_key_arns` defaults to an empty list. Supplying existing
key ARNs adds only `kms:Decrypt` on those keys, restricted by `aws:RequestedRegion`,
`kms:ViaService=secretsmanager.<region>.amazonaws.com`, and the exact approved
migration/verifier secret ARNs in `kms:EncryptionContext:SecretARN`. No KMS
permission is added for an empty list. The module manages neither KMS keys nor
their policies; each existing key policy must permit this use.

## Activation

Use the existing production operator configuration for
`terraform/v2/foundation`. Persist these settings in that configuration so a
subsequent normal plan does not remove the CI resources:

```hcl
github_actions_enabled      = true
github_actions_state_bucket = "<EXISTING_PRODUCTION_STATE_BUCKET>"
github_actions_state_key    = "foundation/terraform.tfstate"
github_actions_migration_secret_arns = [
  "<EXISTING_AURORA_MASTER_SECRET_ARN>",
  "<EXISTING_SQL_READER_SECRET_ARN>"
]
github_actions_secret_kms_key_arns = [
  "<EXISTING_CUSTOMER_MANAGED_SECRET_KEY_ARN>"
]
```

Only include existing secrets used by this stack. Omit the SQL-reader ARN if
that capability has no secret. These are identifiers, not secret values.

Resolve each approved secret's encryption key with the existing operator's
metadata-read permissions. `DescribeSecret` returns `KmsKeyId` for a
customer-managed key; `DescribeKey` resolves that identifier to a full key ARN.
For example:

```bash
aws secretsmanager describe-secret \
  --region "<REGION>" --secret-id "<APPROVED_SECRET_ARN>" \
  --query '{SecretARN:ARN,KmsKeyId:KmsKeyId}' --output json

aws kms describe-key \
  --region "<REGION>" --key-id "<KMS_KEY_ID_OR_ALIAS_ARN_FROM_DESCRIBE_SECRET>" \
  --query 'KeyMetadata.{Arn:Arn,KeyManager:KeyManager}' --output json
```

These commands return identifiers and key metadata only. Use the returned
`KeyMetadata.Arn` values with `KeyManager=CUSTOMER`, deduplicated, in
`github_actions_secret_kms_key_arns`. Inputs must be full `arn:aws:kms:...:key/...`
ARNs in the configured account and region; aliases, bare IDs and wildcards are
rejected. The lookup uses the operator's `kms:DescribeKey` permission; the release
role receives no additional KMS metadata or key-management permissions.

If `DescribeSecret` omits `KmsKeyId`, the secret uses `aws/secretsmanager` and needs
no entry in this list. This foundation assigns a customer-managed Aurora key to
its master secret (`data.tf`), so include that key when granting master-secret
access. See the AWS references for
[DescribeSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DescribeSecret.html),
[DescribeKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_DescribeKey.html),
and [Secrets Manager encryption](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html).

Prepare the saved plan in a private directory (`umask 077`). A targeted bootstrap
can use `-target=module.github_actions_release`; inspect the saved plan and stop
if it proposes changes outside the three CI resources. The controller applies
that reviewed plan without `-auto-approve`. Never publish raw plan/state files.

The resulting outputs are:

- `github_actions_release_role_arn`
- `github_actions_smoke_secret_arn`

Populate the verifier secret separately with JSON containing only `email` and
`password`, for a dedicated non-admin Cognito account. Suppress invitation
messages when provisioning a machine identity. Preserve a working identity on
reruns; missing credentials are not permission to reset an existing user.

The web workflow receives only target metadata and secret ARNs as Actions
variables. It reads the credential through Secrets Manager into a private
temporary file and removes the file on completion or failure. An empty secret
is an explicit setup failure, never a skipped authentication check.

## Verification

Run `tests/github_actions_release.tftest.hcl` with mocked providers. It verifies
the disabled zero-resource plan, exact trust subject, restricted resource paths,
conditional wildcard permissions, optional KMS decrypt conditions, and rejection
of foreign/wildcard inputs and KMS aliases.
Live activation must additionally verify the role through GitHub OIDC and the
workflow's read-only `check` mode before using `deploy`.
