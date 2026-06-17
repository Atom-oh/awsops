# Runbook: Onboard a target account (multi-account) / 타깃 계정 온보딩

AWSops reads connected accounts cross-account by assuming a **read-only** role (`AWSopsReadOnlyRole`)
in each target account, scoped by an **ExternalId** (confused-deputy guard). The host web task role is
the only principal allowed to assume it. AWSops never mutates target-account resources.

## Prerequisites
- Admin access to AWSops (`/accounts` is gated by Cognito `ADMIN_GROUP` or the SSM email allowlist).
- The **host web task role ARN** — from Terraform output `web_task_role_arn` (or the ECS task definition).
- A chosen **ExternalId** string (≥8 chars). Use the same value in the CFN and in `/accounts`.

## Steps
1. In the **target account**, deploy the CloudFormation template:
   ```
   aws cloudformation deploy \
     --template-file infra/cfn/awsops-target-account-role.yaml \
     --stack-name awsops-readonly-role \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       HostTaskRoleArn=<HOST_WEB_TASK_ROLE_ARN> \
       ExternalId=<YOUR_EXTERNAL_ID>
   ```
   The stack outputs `RoleArn` (`arn:aws:iam::<target>:role/AWSopsReadOnlyRole`).
2. In AWSops, open **계정 관리 (`/accounts`)** as an admin → **계정 추가** → enter the target Account ID,
   an Alias, the Region, and the **same ExternalId**. AWSops assumes the role and confirms
   `GetCallerIdentity.Account` matches the submitted ID (status → `verified`) before saving.
3. Use the **global account selector** (sidebar) to switch the active account, or pick **All accounts**
   to aggregate cost / Bedrock across every enabled account (the dashboard aggregates client-side).

## Notes
- **ExternalId is not a secret** — it is a confused-deputy guard, stored in plaintext so AWSops can pass
  it to `sts:AssumeRole`. Treat it like a coordination value, not a credential.
- Host account: no role needed (AWSops uses its own task-role credentials for the host).
- To remove an account, use the **제거** button on `/accounts` (the host row is protected).
- The host web task role is granted `sts:AssumeRole` only on `arn:aws:iam::*:role/AWSopsReadOnlyRole`
  (read-only assume). Tighten the wildcard to specific account IDs if your account set is fixed.
