<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 16d02c16e648 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Gemini, an external reviewer — project context below.

# infra-cdk — module context for reviewers

## What this is
AWS infrastructure-as-code (TypeScript CDK) for the **v1 (legacy) deployment**. Defines all v1 AWS infra across three stacks. NOTE: v2 (under `web/` + `terraform/v2/`) uses **Terraform, not CDK** — CDK is dropped for v2. Changes here only affect the legacy v1 app; do not assume v2 parity.

## Stacks (architectural boundaries)
- **AwsopsStack** (`lib/awsops-stack.ts`) — VPC (3-AZ), EC2 (ARM64/Graviton, Private subnet), ALB (CloudFront-only SG), CloudFront (caching disabled), SSM VPC endpoints, IAM instance profile.
- **CognitoStack** (`lib/cognito-stack.ts`) — Cognito User Pool, App Client, Hosted UI domain, Lambda@Edge (Python 3.12) viewer-request auth.
- **AgentCoreStack** (`lib/agentcore-stack.ts`) — IAM roles + ECR repos for AgentCore scaffolding only. **Actual Runtime/Gateway creation lives in `scripts/06*`, not in CDK** — don't expect this stack to provision the live agent runtime.

Entry points in `bin/*.ts`; context (account/region) in `cdk.json`.

## Conventions a reviewer must enforce
- **Lambda@Edge is us-east-1 only** — CognitoStack must pin `env.region` to us-east-1; any other region is a defect.
- **All compute is ARM64 (Graviton)** — EC2 instance types must be `t4g.*`/Graviton; Docker builds must use `--platform linux/arm64`.
- **ALB security group allows ONLY the CloudFront prefix list** (`com.amazonaws.global.cloudfront.origin-facing`), ports 80–3000. No broad CIDR ingress, no public ALB exposure.
- **EC2 stays in a Private Subnet** — no public IP; access via SSM Session Manager only. Reject public-subnet placement or open SSH.
- **CloudFront CachePolicy = CACHING_DISABLED** — data is real-time AWS state; caching would serve stale data.

## Gotchas / banned patterns
- **Never `cdk deploy --require-approval never`** — IAM and SG changes require manual human review. Flag any automation that bypasses approval.
- **`cdk.context.json` is gitignored and must not be committed** — it is account-dependent and auto-generated per bootstrap.
- This is local-run tooling (deploy from a workstation, not from EC2).
