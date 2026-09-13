# AWSops v2

AWS/Kubernetes operations dashboard and AI diagnosis. The integration branch for
this checkout is `origin/main`; public samples have a separate release path. Read
only relevant module instructions and implementation references.

## Documentation authority

- `docs/decisions/BASELINE.md` is the current decision and gate register; linked
  `docs/decisions/NNN-*.md` files supply rationale and dated amendments.
- Source code, migrations and tests establish implemented behavior. If behavior
  contradicts an accepted invariant, report the discrepancy; do not redefine the
  invariant to match a bug.
- `docs/architecture.md`, `docs/reference/` and `docs/runbooks/` describe current
  implementation and operations. Plans, specs and historical reviews are design
  evidence, not permission to enable features. Legacy ADR numbers require
  `docs/decisions/ADR-MAPPING.md`; an unqualified number means a consolidated ADR.
- New or rewritten developer/reviewer documentation is English-only. Convert a
  maintained document as a whole when updating its language; retain its facts.
  Existing untranslated bodies are a migration backlog, not a bilingual mandate.
  Keep the multilingual
  `docs-site` user guides and application translations. Do not require bilingual
  developer docs or restore duplicate translations.
- `CLAUDE.md` is the context source. Distill `AGENTS.md` with `/co-agent sync-context`
  after editing it; Kiro steering references the same `AGENTS.md`. Keep scoped
  instructions short and avoid duplicated policy, hand-maintained file counts,
  transient release status and claims that a default-off feature is deployed.

## Product boundaries

| Area | Current rule |
| --- | --- |
| AWS mutation and autonomy | ADR-005 **FROZEN**: no automatic remediation, mutating tools or arbitrary BYO-MCP. Retained dark code is allowed; enabling it is a violation. Unfreezing requires a new ADR, multi-AI review and dated owner override. |
| Secret-rotation restart | ADR-015 permits only `ecs:UpdateService(forceNewDeployment)` on the host web service after its own Aurora secret rotation, same image/task definition, one service ARN, secret-id fail-closed, default-off. |
| Incident analysis | ADR-006 **GATED**, analysis-only: incident lifecycle, RCA write-back, K8sGPT. No autonomous mitigation. |
| External data | ADR-007 governs curated external reads and writes separately from AWS-resource mutation. `integrations_write_enabled` is **GATED-OFF**, not FROZEN. `diagnosis_notify_enabled` is the narrowly governed SNS notification path. Neither classification authorizes broader writes. |
| Curated MCP presets | ADR-017 **GATED**, vendor-hosted presets with fail-closed runtime tool allowlists; arbitrary `custom_mcp` and ClickHouse stdio embedding remain FROZEN. |
| SG-rule activity | ADR-019 is an ordinary GATED read-only Athena query path, not another ADR-005 exception. |

Operator-authorized deployments, account onboarding and teardown are operations
outside the application's autonomy boundary. They still require the task's
approval scope, least privilege and a reviewed saved Terraform plan. Any AWS
mutation reachable through the product UI, API or agent remains FROZEN regardless
of who requests it, except for the exact ADR-015 path.

## Architecture and code ownership

- **Web:** `web/`, Next.js 14 App Router, standalone arm64, root `/` and `/api/*`.
  Components use default exports. No v1 `/awsops` basePath or JSON-file app state.
- **Data:** Aurora via `web/lib/db.ts:getPool`. Schema is the frozen
  `terraform/v2/foundation/data/schema.sql` **plus** ULID migrations under
  `terraform/v2/foundation/migrations/`. Add migrations, not baseline edits.
  A merged migration and its `-- since:` header are checksum-immutable.
- **Edge:** CloudFront TLS -> VPC Origin HTTPS:443 -> internal ALB HTTPS:443 ->
  web HTTP:3000. ALB ingress uses the CloudFront VPC Origins service SG.
- **Auth:** Cognito closed signup and admin-only account recovery; Lambda@Edge
  validates RS256/JWKS, issuer, audience and token use. `/login` uses the self-hosted
  login BFF; Hosted UI PKCE is a fallback. The exact public-path allowlist lives in
  `terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl`; additions need review.
  BFF data/billable routes use `verifyUser`, session revocation and ownership checks;
  `/api/db`, `/api/stream` and separately authenticated `/api/incidents/webhook` are
  the documented data-route exceptions. Login/signout/health are entry/health routes.
- **Ownership:** immutable Cognito `sub`; `web/lib/admin.ts` defines admin authority.
  `legacy_email_owner_match` defaults true during migration. Keep `matchesIdentity`
  compatibility until an actual applied backfill confirms zero legacy owner rows.
- **AI:** `agent/` and `agent/lambda/`, AgentCore Runtime plus section gateways.
  SSM `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` is runtime
  configuration; no ECS `valueFrom` race. Live domain reads use MCP tools; the BFF
  also has bounded service-specific reads. Models and gateway membership come from
  configuration/catalog source, not prose inventories.
- **Inventory:** `steampipe_enabled` gates the Steampipe FDW and batch sync into
  Aurora. The Powerpipe CIS worker uses that FDW; the FinOps EBS rule instead
  requires fresh persisted inventory evidence. Live
  Steampipe SQL in `aws-data` and auto-collect handlers is deliberately disabled by
  `steampipeAvailable()`. Those registered routing keys fall back to normal routing;
  they are not active collectors. Never replace this hard-disable with a check of
  `steampipe_enabled`. ADR-010/021 define partial/freshness semantics.
- **Jobs:** heavy work uses ownership-checked domain routes (`/api/diagnosis`,
  `/api/compliance/run`) -> `worker_jobs` + SQS -> dispatcher -> Step Functions ->
  Lambda/Fargate worker. Generic `POST /api/jobs` accepts only the noop allowlist.
  Workers record running/succeeded; catch handler and reaper reconcile failures.
- **EKS:** the web-role Access Entry uses `AmazonEKSAdminViewPolicy`; tool-specific
  roles may have different view policies. Registration does not authorize mutation.
- **Terraform:** origin root `terraform/v2/foundation/`; public samples use
  `terraform/foundation/`. Do not copy paths across repositories without checking.
  v2 has no CDK deployment. Version requirements live in `backend.tf`/manifests.

## Required implementation rules

- No world-open ingress, unscoped IAM wildcard principals/actions, hardcoded secrets,
  public ALB, Cognito self-signup or weakened signature/ownership verification.
  Store credentials in Secrets Manager/SSM; do not log them. Identifiers such as
  account IDs/ARNs are not credentials by themselves; use placeholders in examples.
- Frozen substrate pointers: `terraform/v2/foundation/remediation.tf` and the narrow
  restart exception in `secret-rotation.tf`; retain their default-off guards.
- New large features default off and gate their resources. Default-off does not
  imply the whole stack is free or that a fresh foundation plan has no changes.
- Never use `terraform apply -auto-approve` on shared infrastructure. Review a saved
  `tfplan`; the controller executes that exact plan. Keep SG `description` unchanged
  to avoid replacement of attached groups.
- Build web/agent/worker images for arm64. Set `HOSTNAME=0.0.0.0` in the web task's
  runtime environment; image ENV alone is insufficient. Health path: `/api/health`.
- Fargate worker Dockerfiles use `CMD`, not exec-form `ENTRYPOINT`, so Step Functions
  command overrides do not append duplicated arguments.
- ECS secret injection needs execution-role permissions. Application API access
  belongs to the task role; do not confuse the two.
- Preserve gateway canonical/`v2-` key fallback in `_resolve_gateway_key` and the
  host-account `get_role_arn() -> None` behavior. They prevent silent wrong-gateway
  routing and self-assumption of a target-only role.

## Commands (repository root)

```bash
npm ci --prefix web
(cd web && npm run build)
(cd web && npx vitest run)
(cd agent && python3 -m pytest test_agent.py -q)
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v
bash scripts/v2/merge-verify.sh
bash tests/run-all.sh
```

There is no root package.json and no web lint script. The merge runner isolates each
Python test file; do not replace it with aggregate pytest discovery. Its Terraform
checks are opportunistic/non-blocking; see `docs/v2-merge-verification.md` for actual
CI stages. Database integration tests `scripts/v2/*.itest.mjs` use disposable Docker
PostgreSQL, not live Aurora. Select checks relevant to the change and required CI.

```bash
make configure
terraform -chdir=terraform/v2/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/v2/foundation validate
terraform -chdir=terraform/v2/foundation plan -out tfplan
# Review the plan before the controller runs: terraform ... apply tfplan
make migrate
make deploy
make agentcore
make workers
```

These deployment targets are separate operations, not an unconditional sequence.
`make deploy` runs migrations before the arm64 build/ECR push/ECS rollout/health smoke.
`make agentcore` requires Terraform apply **and** `make migrate` first; it does not
ship MCP Lambda code (Terraform does). `make workers` publishes the worker image
and requires worker infrastructure. See `make help` and the deployment runbook.

## Review and completion

Review the latest PR HEAD and its diff against the intended base. Read the relevant
base files and account for additions/removals in the patch before declaring a symbol,
permission, migration or feature missing. Use current decisions, not retired plans,
old test descriptions or a different repository's paths. Cite a concrete changed
behavior and evidence for each finding; disagreement in documentation is not proof
that the implementation violates policy. Documentation can itself have a serious
operational/security defect; calibrate severity to its demonstrated effect.

Fix verified Critical/Major findings, run relevant tests and required CI, push and
obtain a fresh AI review. Missing, failed, truncated or incomplete review is not a
clean review. Merge only when the latest HEAD is reviewed, no Critical/Major remains,
required checks pass and the base/integration path is correct. Do not bypass checks.

Changelog: one bullet per feature/category, amend net behavior instead of adding
review-round or PR-number entries. No new bullet is required when an existing one
already describes the change. Keep release provenance and version ordering intact;
`web/lib/changelog.ts` falls back per whole version, not per bullet. The maintained
CHANGELOG is now English-only, so Korean readers receive the full English version
body; legacy bilingual input is still supported by the parser.

<!-- AUTO-MANAGED:references -->
Implementation reference index: [docs/reference/README.md](docs/reference/README.md).
<!-- /AUTO-MANAGED:references -->

Start with `docs/README.md` for documentation scope and navigation. v1 code is retained
in git history (`v1-pre-code-removal-20260712`), not a source of v2 rules. Teardown
status belongs in its dated runbook, not in every context file.
