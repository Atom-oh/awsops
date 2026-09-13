# Onboard a target account

Cross-account reads assume `AWSopsReadOnlyRole` in a registered target account.
Trust is pinned to the required host role ARNs. ADR-011 permits explicitly selected
first-party accounts to omit ExternalId; third-party/shared accounts require it.
This operator setup does not authorize application-side resource mutation.

## Prerequisites

Use an AWSops admin and authorized target-account deployment credentials. Resolve
the web role's `taskRoleArn` from the host ECS service's deployed task definition;
this Terraform root does not export `web_task_role_arn`. From the repository root,
with the host AWS session and region selected:

```bash
HOST_WEB_CLUSTER=$(terraform -chdir=terraform/v2/foundation output -raw ecs_cluster_name)
HOST_WEB_SERVICE=$(terraform -chdir=terraform/v2/foundation output -raw ecs_service_name)
HOST_WEB_TASK_DEFINITION=$(aws ecs describe-services \
  --cluster "$HOST_WEB_CLUSTER" --services "$HOST_WEB_SERVICE" \
  --query 'services[0].taskDefinition' --output text)
HOST_WEB_ROLE_ARN=$(aws ecs describe-task-definition \
  --task-definition "$HOST_WEB_TASK_DEFINITION" \
  --query 'taskDefinition.taskRoleArn' --output text)
```

The optional `worker_task_role_arn` output is used only for worker-side member-account
inventory or Network Path Check identity reads. Athena activity uses the separate
`AWSopsSgRuleAthenaRole`, not this worker trust parameter. The template does not
automatically trust every host collector or AgentCore role; verify the principal
used by the intended read path.

For worker reads, the host must already have worker infrastructure applied with
`workers_enabled=true`. Resolve its role from the host backend before adding worker trust:

```bash
HOST_WORKER_ROLE_ARN=$(terraform -chdir=terraform/v2/foundation output -raw worker_task_role_arn) || exit 1
test -n "$HOST_WORKER_ROLE_ARN" && test "$HOST_WORKER_ROLE_ARN" != null || exit 1
```

For third-party accounts, choose an ExternalId of at least eight characters and use
the same value in the template and account registration. ExternalId is a coordination
value/confused-deputy guard, not a credential.

## Provision and register

Set the deployment's actual profile and role ARN variables before running. This
example uses only the web role; add the optional worker parameter when required.

```bash
: "${TARGET_EXTERNAL_ID:?Set the reviewed ExternalId; third-party targets require it}"
aws cloudformation deploy \
  --profile "$TARGET_PROFILE" \
  --template-file infra/cfn/awsops-target-account-role.yaml \
  --stack-name awsops-readonly-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    HostTaskRoleArn="$HOST_WEB_ROLE_ARN" \
    ExternalId="$TARGET_EXTERNAL_ID"
```

Only for explicitly first-party onboarding without ExternalId, replace the assertion
with `TARGET_EXTERNAL_ID=''` and keep the empty parameter (or omit that parameter).
Do not use this alternative for third-party/shared accounts.
For worker reads, add `WorkerTaskRoleArn="$HOST_WORKER_ROLE_ARN"` to the parameter
list. Review the exact trust-policy change before updating an existing stack.
Do not broaden it to wildcard principals to work around AccessDenied.
Some host policies use `arn:aws:iam::*:role/AWSopsReadOnlyRole`; an exact registered-account
ARN allowlist is stricter. Tightening that host scope is a separate reviewed Terraform change.

As an AWSops admin, open `/accounts`, add the target ID, alias, region and matching
ExternalId. If omitting ExternalId, explicitly select the first-party checkbox.
Registration verifies `GetCallerIdentity.Account` before saving. Select the target
account and verify the specific read path, not only the registration result.

The host account needs no target role; it uses its own execution credentials.
The host row cannot be removed through account deletion. See
[network-path EKS access](network-path-eks-access.md) for worker Kubernetes reads.

Sources: `infra/cfn/awsops-target-account-role.yaml`, `web/app/api/accounts/`,
[ADR-011](../decisions/011-multi-account.md).
