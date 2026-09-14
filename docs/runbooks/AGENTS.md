<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: c8a55b37edec · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> Reviewer context distilled from CLAUDE.md and shared across AI reviewers.

# Runbook review

Use English-only developer procedures; product user guides remain multilingual.
`CLAUDE.md` indexes current v2 runbooks, including the AI PR-review panel runbook
for Kiro cell failure modes. Verify commands against the actual code,
working directory, deployment surface and migration dependency. Use configured
variables/placeholders and never expose credentials.

`../decisions/BASELINE.md` defines current gates. Operator-authorized deployment,
onboarding and teardown are distinct from autonomous product action, and still
require appropriate authorization and reviewed saved Terraform plans. Do not enable
frozen features or widen IAM to make a runbook succeed.

Preserve dated evidence; distinguish a supported procedure from executed work.
An old plan, status table or absent verification cannot prove current deployment or
teardown. v1 EC2/CDK/startup and embedded-Steampipe procedures are retired; do not
require their restoration in current runbooks. Use the ADR mapping for legacy IDs.
