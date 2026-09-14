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
```

Only include existing secrets used by this stack. Omit the SQL-reader ARN if
that capability has no secret. These are identifiers, not secret values.

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
conditional wildcard permissions, and rejection of foreign/wildcard inputs.
Live activation must additionally verify the role through GitHub OIDC and the
workflow's read-only `check` mode before using `deploy`.
