# ADR-011: Multi-Account Read-Only Federation

## Status

Accepted **2026-06-22**, consolidating legacy ADR-008.
Amended **2026-06-26**: ExternalId optional only with exact first-party principal pinning.
Amended **2026-08-25**: optional worker principal in target-account trust.
Repository evidence checked **2026-09-13**.
Amended **2026-10-29**: records the collector principal, host-only and verification-target
scopes, onboarding diagnostics, the EKS member-role model and account/region graph identities,
checked against public `samples/dev` `5bac16f2` (2026-10-24). Checked-in code, not observed deployment.

## Context

v2 runs in a host account and **implements multi-account reads**. Target accounts should be registered
without a code change, with single-account behavior retained. One host deployment does not mean
"single-account only."

## Decision

- Store registered targets in Aurora `accounts`, seed the host lazily, and provide admin-managed
  account registration. Use the account selector for per-account views and explicit all-account fan-out.
- Assume the target `AWSopsReadOnlyRole`. For first-party trust pinned to the exact host task-role ARN,
  ExternalId is optional. Third-party/shared trust requires ExternalId. This distinction is enforced
  by the target trust policy and operator configuration, not inferred automatically by application code.
- `infra/cfn/awsops-target-account-role.yaml` supports the host web principal and an optional
  `WorkerTaskRoleArn` (default empty). Existing target stacks do not gain worker trust until an operator
  updates them. The same ExternalId rules apply to each principal.
- Accepted tradeoff of the **2026-08-25** amendment: the shared worker role can assume the target's
  full `ReadOnlyAccess` surface, not only the Describe calls used by Network Path/SG inventory.
  This reuses the existing onboarding model and avoids another per-feature target role. A narrower
  role remains optional future hardening, not a retroactive requirement to approve this pattern.
- When the requested account is the host, `cross_account.get_role_arn()` returns `None` and uses
  the execution role directly. Do not reintroduce a target-only-role self-assume or diagnose its
  expected absence as broken cross-account trust.
- ADR-019's Athena broker role is separate: it has stricter explicit-principal **and ExternalId**
  requirements and must not be merged into `AWSopsReadOnlyRole` or assumed by the shared worker role.

### Amended 2026-10-29

- **Collector principal.** The target template also accepts an optional `InventoryTaskRoleArn`
  (default empty) for the host inventory collector task role, required for multi-account
  inventory collection. It follows the same exact-principal and ExternalId rules; existing stacks
  gain collector trust only when an operator updates them.
- **Host-only mode.** `inventory_host_only` (default false) restricts the collector to the verified
  host account and omits its cross-account AssumeRole. While set, `POST /api/accounts` rejects a
  new target with 409 after authentication/admin checks and before STS or registry writes; reads,
  connection re-tests and removal are unchanged.
- **Verification targets.** Explicit `runtime_verification_targets` (at most five foreign accounts,
  requires host-only off) scope collector AssumeRole to the exact target roles for development
  release verification. That is operator CI, not an ADR-005 exception. When configured,
  registration outside that scope is rejected with 409; an empty list keeps the earlier scope.
- **Onboarding diagnostics.** An admin-only onboarding check performs a bounded, read-only host
  STS / AssumeRole / target identity probe and never writes the registry. It probes only enabled
  registered targets or applied allowlist entries; missing or malformed configuration fails closed.
  Diagnostics exclude provider error text, credentials and the ExternalId value.
- **EKS member reads.** Member-account EKS reads use the registered member read role with an
  owner-granted Access Entry plus `AmazonEKSViewPolicy` and the minimal `awsops:eks-readonly`
  node-read binding, never `AmazonEKSAdminViewPolicy` on the shared member role. A failed member read
  never falls back to host credentials. The host's own AdminView entry is unchanged. AWSops
  generates the guide; the cluster owner applies the access entry and binding.

## Consequences

One deployment can show registered target accounts, with fan-out latency/quota cost proportional to
scope. Target-role installation remains an operator action. Shared read-only trust is intentionally
broad; no mutation or autonomous mitigation follows from account onboarding.

Amended 2026-10-29: cross-account fan-out keys resource-graph identities by account and region
(`kind:@<account>:<region>:<id>`), so identical resource IDs in different accounts or regions never
merge. Host-only and verification-target scopes bound which accounts the collector may read.

## Six Pillars

Security: explicit trust and credential scoping. Reliability: direct host access and durable registry.
Operational Excellence: runtime registration. Performance/Cost/Sustainability: scoped queries and
one host rather than a deployment per account.

## Evidence

`web/lib/accounts.ts`, `agent/lambda/cross_account.py`, `infra/cfn/awsops-target-account-role.yaml`,
`terraform/v2/foundation/{workload,network-path,sg-rules}.tf`, and ADR-019.
Added 2026-10-29 (public `samples/dev` paths, `terraform/foundation/` there):
`terraform/foundation/{runtime-read-scope,steampipe}.tf`, `web/app/api/accounts/route.ts`,
`web/app/api/accounts/onboarding/route.ts`, `web/lib/{eks-member-rbac,graph-identity}.ts`,
and `docs/reference/07-eks.md`.
