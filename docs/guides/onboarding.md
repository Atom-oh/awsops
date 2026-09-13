# v2 setup

Use [developer onboarding](../onboarding.md) and the
[deployment runbook](../runbooks/deploy-new-version.md). These maintained documents
replace the retired EC2/CDK and embedded-Steampipe installation instructions.

v2 uses `web/`, root `/api/*` routes, Aurora state and Terraform under
`terraform/v2/foundation/`. Old v1 setup steps remain in git history; do not apply
them to this checkout. Multilingual product guides are maintained in `docs-site/`.
