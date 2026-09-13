<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: b85e745c0e52 · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo. This context is distilled from
> CLAUDE.md and shared by Kiro, Codex and Agy.

# AWSops review context

v2: `web/` Next.js thin-BFF, Aurora, AgentCore and asynchronous workers. Private
Terraform root: `terraform/v2/foundation/`; public samples use `terraform/foundation/`.
Verify the checkout before applying paths. No v1 basePath, JSON-file app state or CDK.

## Evidence and policy

Read `docs/decisions/BASELINE.md` for current gates and linked consolidated
`NNN-*.md` ADRs for rationale. Code/migrations/tests establish behavior; accepted
invariants establish allowed behavior. Investigate contradictions; do not declare
code correct merely because it exists. Legacy numbers require ADR-MAPPING.md.
Plans/specs/review archives are historical evidence, not current authorization.

Developer/reviewer docs are English-only. Multilingual docs-site guides and app
translations remain. Do not require bilingual developer docs, new changelog bullets
already covered by an existing feature entry, static component counts or missing
ADR bodies in public samples. Changelog entries describe net feature behavior;
no PR/review-round numbers or duplicates. Preserve version provenance.

| Boundary | Rule |
| --- | --- |
| ADR-005 FROZEN | No AWS-resource mutation/autonomous remediation/arbitrary BYO-MCP. Dark substrate may remain. Enabling requires a new ADR, multi-AI review and dated owner override. |
| ADR-015 exception | Only own web-service `forceNewDeployment` on own Aurora secret rotation, same image/task definition, one service ARN, secret-id fail-closed, default-off. |
| ADR-006 GATED | Incident lifecycle/RCA/K8sGPT are analysis-only, default-off; no autonomous mitigation. |
| ADR-007 external data | Curated reads and governed writes are separate from ADR-005. `integrations_write_enabled` is GATED-OFF; SNS diagnosis notification has its own narrow gate/governance. |
| ADR-017 GATED | Curated vendor-hosted MCP presets use runtime tool allowlists. Arbitrary custom MCP and embedded ClickHouse stdio stay FROZEN. |
| ADR-019 GATED | SG-rule Athena activity is read-only; not another mutation exception. |

Operator-authorized deploy/onboarding/teardown is not application autonomy. Apply
normal task authorization and reviewed saved-plan discipline.

## Implementation checks

- `/api/*`, no `/awsops` prefix. Shared `web/lib/db.ts:getPool`; frozen schema **plus**
  ULID migrations. Never edit merged migration contents or `-- since:` headers.
- CloudFront -> VPC Origin HTTPS443 -> internal ALB HTTPS443 -> web HTTP3000.
  No public ALB/world-open ingress, unscoped IAM wildcard principal/action or secrets
  in code/env/IaC. Secrets Manager/SSM hold credentials; identifiers are not secrets.
- Edge RS256/JWKS + issuer/audience/token use; review changes to the public allowlist
  in `edge-lambda/cognito_edge.py.tftpl`. Closed Cognito signup/admin-only recovery.
  BFF data/billable routes verify users, revocation and ownership; documented data
  carve-outs are `/api/db`, `/api/stream`, `/api/incidents/webhook` (alternate auth).
  Login/signout/health are entry/health routes, not new carve-outs.
- Ownership uses Cognito `sub`; admin authority is `web/lib/admin.ts`. Preserve
  default-true `legacy_email_owner_match`/`matchesIdentity` until a completed applied
  backfill confirms zero legacy rows. A clean preview alone is insufficient.
- Heavy jobs use ownership-checked domain routes. Generic `/api/jobs` only accepts
  noop job types. SQS/SFN workers, catch handler and reaper own job status recovery.
- AgentCore settings are read from SSM at runtime. Preserve canonical/`v2-` gateway
  fallback and host-account `get_role_arn() -> None`; both are deliberate fixes.
- Live `aws-data`/collector Steampipe paths are hard-disabled and fall back to normal
  routing. `steampipe_enabled` gates batch inventory only. Partial/stale/unassessed
  evidence is not a healthy zero; follow ADR-010/021 and the actual producer schema.
- New large features default off; this does not mean an entire fresh stack costs $0.
  No `-auto-approve` for shared Terraform; controller applies the reviewed saved plan.
  Do not change attached SG descriptions. Web EKS Access Entry uses AdminView policy.
- arm64 images; web runtime `HOSTNAME=0.0.0.0`; `/api/health`; worker Dockerfile CMD,
  not exec ENTRYPOINT. ECS secret injection permissions belong to the execution role.

## Validation (repository root)

```bash
npm ci --prefix web
(cd web && npm run build)
(cd web && npx vitest run)
(cd agent && python3 -m pytest test_agent.py -q)
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v
bash scripts/v2/merge-verify.sh
bash tests/run-all.sh
```

No root package.json or web lint script. Python tests run per file to isolate module
state. `docs/v2-merge-verification.md` explains required CI versus local checks.
`make deploy` runs migrate/build/push/roll/smoke; `make agentcore` requires apply and
`make migrate` separately. Terraform apply ships MCP Lambda code, not `make agentcore`.

Review the latest HEAD against its intended base. Read base files and apply the
visible patch logically before reporting missing symbols/permissions/migrations.
Report concrete evidence and impact; old prose/test names alone are not policy.
Fix verified Critical/Major findings and obtain fresh review after every push.
Missing/failed/truncated/incomplete coverage is not clean. Merge only the reviewed
HEAD with no unresolved Critical/Major and required checks passing; never bypass CI.
