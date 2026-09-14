# Origin runtime Actions handoff

This default-off module creates a **separate** `${project}-ci-runtime` role and
up to three bounded managed policies. It never edits the web release role, existing
workload roles, OIDC provider, security groups, DNS, component flags, or images.
It grants no S3 or Terraform-state access. AgentCore permissions are omitted
when the existing AgentCore role identifier is absent.

Integrate the shared private migration and guard/preparation utilities before
the runtime controller/workflow. The controller imports `ci_origin_common` and
`ci_origin_migration`; their source, receipt and cleanup contracts are shared
with the web release path. Runtime Python tests are included by the existing
isolated test runner, and Merge Verify explicitly includes the runtime Terraform
test file.

## Operator activation

At the 2026-09-14 handoff, production `ci_readiness_enabled` is false. AgentCore
deployment needs a separate reviewed operator apply; this change does not enable it.

An operator with separate Terraform/state privileges prepares and reviews a
saved plan. Set `github_actions_runtime_enabled = true` and provide existing
identifiers in `github_actions_runtime_subnet_ids` and
`github_actions_runtime_security_group_ids`. Set `github_actions_runtime_secret_arns`
only when the optional project integration secret is needed. Database master and
reader secrets are rejected by the runtime role's allowlist. The private migration
task owns those permissions. Add `github_actions_runtime_secret_kms_key_arns`
only for approved customer-managed integration-secret keys. The subnet and
security-group identifiers must match the existing AgentCore VPC configuration.

The root module call uses identifiers and existing component flags rather than
managed workload-resource references. This keeps activation of
`module.github_actions_runtime` from pulling database, execution-role, or VPC
changes into a targeted plan. Review the actual saved plan before applying it.
The metadata output is separate and may reference existing resources.
If a targeted activation prunes that new output, materialize it with a separately
reviewed refresh-only plan; do not apply unrelated workload changes just to export
metadata.

The existing GitHub OIDC provider must already have the GitHub issuer and
`sts.amazonaws.com` audience. The module validates this prerequisite and never
updates the provider.

## Protected production variables

Use the existing `AWSOPS_ACCOUNT_ID`, `AWSOPS_PROJECT`, and `AWSOPS_REGION`.
Set `AWSOPS_RUNTIME_ROLE_ARN` from `github_actions_runtime_role_arn`.
For AgentCore, activate the separately reviewed `github_actions_migration` module
and set `AWSOPS_MIGRATION_CONFIG_JSON` from `github_actions_migration_config`.
The runtime migration-policy attachment is created only when both the runtime
role and the private migration executor are enabled. Include that attachment in
the reviewed activation plan.

An operator exports **only**:

```sh
terraform -chdir=terraform/v2/foundation output -json github_actions_runtime_metadata
```

Store that object as the protected production variable
`AWSOPS_RUNTIME_METADATA_JSON`. Never substitute a full `terraform output -json`,
state file, tfvars file, or secret value. Refresh the metadata after reviewed
task-definition, image-pin, network, or component configuration changes.

The strict v1 object contains:

- `version`, `account_id`, `project`, `region`.
- `migration`: `aurora_endpoint`, `aurora_database`, `aurora_secret_arn`,
  `agent_sql_reader_secret_arn`; these are connection metadata and ARNs.
- `components.worker`: ECR/cluster/task-definition/state-machine identifiers,
  current image reference, execution/task-role ARNs, existing private network.
- `components.steampipe`: ECR/cluster/task-definition/service identifiers and
  current image reference.
- `components.agentcore`: `cloudfront_id` and the allowlisted `provision` inputs
  exported by the root output. Disabled components are `null`.

CI checks source, caller, identifier scope, actual ECS/SFN configuration and RDS
cluster identity. AgentCore gets `--config` and `--image repository@sha256:...`;
it does not read Terraform. `prepare` creates a private `CI_MIGRATION_RECEIPT`
path. The shared `ci_origin_migration.py` controller runs migrations in private
Fargate and writes context, database, digest, mode and nonce-bound proof to it.
`runtime migrate --digest ...` calls `Migration.verify_receipt(database, "apply")`
and rechecks the actual stopped task and image. It repeats receipt verification
before provisioning. No runtime CI process connects directly to Aurora.

The shared helper's `prepare-build` exports an allowlisted `git archive` of
`CI_COMMIT_SHA` into the private run directory. Both Docker build context and
Dockerfile come from that committed archive, including the migration-specific
dockerignore file. All migration inputs must therefore be committed in the
reviewed source; untracked inputs fail the guard and ignored local files cannot
enter the image.

The migration image uses `Dockerfile.origin-migration`, `SOURCE_COMMIT`, Linux
ARM64, `provenance: false` and `sbom: false`, then is pushed as `migration-<sha>`.
The current shared helper uses
the project web ECR repository. Runtime access to build there is enabled only
with the private migration module; ECR has repository-level authorization rather
than an image-tag condition for `PutImage`, so the workflow constrains tag names.

Residual IAM authority remains broader than the fixed controller calls:
`ecs:UpdateService` authorizes other fields of the project Steampipe service,
and `RunTask`/`PassRole` authorize the scoped task families and execution roles.
The shared migration policy permits `StopTask` only in the project cluster for
tasks tagged `Project=<project>` and `Purpose=ci-migration`. Runtime probe cleanup
likewise requires `awsops:project=<project>` and `awsops:purpose=ci-runtime-probe`.
Exact commands, image checks and ownership of an individual run are additional
controller enforcements, not claims that IAM restricts each request field.
Protect the production environment, reviewed source and runner accordingly.

## Release behavior

The production job uses GitHub-hosted `ubuntu-24.04-arm` for native ARM64 Docker
builds and public AWS API access. Database execution stays inside private Fargate.

Dispatch `deploy-runtime.yml` on origin/main. `mode=check` is the default and
performs no publishing, provisioning, task launch, or model invocation.
`mode=deploy` requires reviewed main/CI coverage, builds Linux ARM64, binds the
commit tag to the manifest digest, and proves component consumption.

- AgentCore requires applied `ci_readiness_enabled`, working read-only inventory
  tools, fresh inventory for the exported CloudFront ID, and model access. CI
  does not enable those prerequisites. It checks the pinned READY version,
  DEFAULT endpoint, and a fresh nonce-bound readiness response. The current
  operator catalog supports the `awsops-v2` project. Private migrations run before
  provisioning; check mode validates executor metadata without launching a task.
- Worker uses the existing task-definition family and a fixed
  `--ci-probe <nonce>` entrypoint. It requires the actual image digest, exit zero,
  and matching startup/DB/schema log evidence. It creates no task-definition
  revision, writes no job rows, and stops only its own tagged probe on cleanup.
- Steampipe force-deploys the existing task definition, then checks the exact
  PRIMARY deployment, task image digests, and health. Rollback is failure.

Mutable tags are promoted before runtime verification; publishing alone never
marks a release complete. Failures do not automatically roll back image tags.
Pinned ECS images must already match a reviewed Terraform pin; CI never changes
the pin or task definition. Supply `image_digest` to reuse an existing
`<component>-<commit>` artifact after that reviewed pin update.

Migration cleanup delegates to the shared helper and retains immutable migration
task-definition revisions for audit. If cleanup cannot confirm ownership/status,
the runtime helper preserves the private receipt rather than deleting recovery
evidence. No shared EKS ingress is needed; migrations use the approved private
Fargate network and the existing application security group.

Before the first live dispatch, verify that the private migration module and
runtime policy attachment have been applied, both protected metadata variables
reflect that applied configuration, and the selected component's existing
infrastructure is enabled. The runner needs AWS CLI, Git, GitHub CLI and Docker;
the workflow installs Python/SDK and Buildx. Terraform-owned Lambda code and
changed task-definition pins still require a separate privileged reviewed apply.
Offline tests establish controller contracts, not live network reachability.

IAM resource kinds/conditions are based on AWS's primary service-authorization
JSON at `https://servicereference.us-east-1.amazonaws.com/v1/<service>/<service>.json`.
Offline checks: `test_ci_origin_runtime.py`, `github_actions_runtime.tftest.hcl`,
and actionlint on the new workflow. Live releases are separate operator actions.

On 2026-09-14, the three permission policies were rendered with fixed test account
`123456789012`, including optional migration-image and KMS permissions, and sent
to the read-only IAM Access Analyzer `ValidatePolicy` API. All three returned no
findings after correcting the ECS execute-command condition to `StringEquals`
and bounding runtime IDs to the API's ten-character suffix.

The trust policy retained `CONFIRM_AUDIENCE_CLAIM_TYPE` (suggestion) and
`SPECIFIC_GITHUB_REPO_AND_BRANCH_RECOMMENDED` (warning). Its audience already uses
scalar `StringEquals`, without a set qualifier; its exact subject is
`repo:Atom-oh/awsops:environment:production`, not a wildcard. Keep main-only
workflow/source checks and production-environment deployment-branch restrictions.
Policy validation is not proof of live authorization or resource readiness.
