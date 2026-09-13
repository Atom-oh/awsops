# Terraform

Read root [CLAUDE.md](../CLAUDE.md) and
[BASELINE.md](../docs/decisions/BASELINE.md) for policy. This origin checkout's v2
foundation root is `terraform/v2/foundation/`; `v2/bootstrap/` is separate bootstrap
infrastructure. Use checked-in source paths, not paths copied from another tree.

## Workflow

From the repository root:

```bash
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out tfplan
```

The controller applies the saved plan; never use `-auto-approve` on shared
infrastructure. `backend.hcl` is local partial S3 configuration. Keep credentials,
state, plans, and sensitive tfvars out of commits; use the example configs.
Version constraints are declared in `backend.tf`; selections are in the lockfile.
Merge Verify pins Terraform 1.15.7 and requires `tests/runtime_iam.tftest.hcl`
with mocked providers and `init -backend=false`; no AWS credentials are supplied.

## Review boundaries

- `v2/foundation/runtime-read-scope.tf` defines opt-in host-only inventory,
  nullable inventory/worker image digests, region/model scopes and verifier provisioning.
  Web SSM access names exactly three project parameters. Runtime Gateway/model and
  worker task permissions are scoped; allowed host reads retain enabled regions
  and global endpoints. Terraform omits only collector cross-account role grants in host-only mode; Agent MCP
  grants and original credential-report access remain. Optional ci_readiness_enabled creates
  the verifier app group without an IAM role; private membership is operator-managed.
  These configuration checks do not prove effective deployed access or collection.

- Preserve private CloudFront VPC Origin access to the internal ALB, scoped IAM,
  closed Cognito signup/admin-only recovery, and root security mandates.
- Keep SG descriptions unchanged; modify ingress in place. Images remain arm64;
  web task definitions set runtime `HOSTNAME=0.0.0.0` and `/api/health` checks.
  Fargate workers use `CMD` for command overrides.
- New large capabilities default off. Check actual flag declarations and
  dependencies in the relevant `.tf` files. A disabled feature adds no resources
  for that feature; it does not prove the entire stack plan has no changes.
- AWS-resource mutation/autonomy remains FROZEN (`remediation_enabled`). Disabled
  substrate is retained. ADR-015 permits only the gated secret-rotation restart
  of the host web service, with unchanged image/task definition and scoped IAM.
- `integrations_write_enabled` is GATED under ADR-007: independent control plane,
  no AWS-mutation IAM, and SSRF/Secrets/DLP/human-gate controls. SNS notification
  is the narrowly governed external-data write and defaults off; historical ON
  labels in BASELINE do not establish current deployment. Do not reclassify all
  writes as frozen. RCA write-back cannot activate while it depends on frozen remediation
  roles. Curated MCP and ClickHouse stdio have distinct gates in BASELINE.
- `legacy_email_owner_match` is a default-true migration switch; do not treat it
  as a new feature flag or disable it before the required backfill is complete.

Schema changes use new ULID files under `v2/foundation/migrations/`, applied by
`make migrate`. Preserve the frozen `data/schema.sql` and merged migration
contents/checksums, including `-- since:`. Operator-authorized emergency IAM
changes must match the Terraform policy name/document so the next apply converges.
