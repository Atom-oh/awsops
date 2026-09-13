# v2 installation

Start with [developer onboarding](../onboarding.md) for prerequisites and setup.
For an authorized v2 release, follow the [root deployment guidance](../../CLAUDE.md#commands-repository-root)
and run `make deploy` from the repository root. It migrates, builds the arm64 image,
pushes to ECR, rolls ECS, and checks `/api/health`.

v2 uses `web/`, root `/api/*` routes, Aurora state and Terraform under
`terraform/v2/foundation/`. The v1 EC2/CDK deployment runbook is not this procedure.
Multilingual product guides are maintained in `docs-site/`.
