# ADR-011: Multi-Account Read-Only Federation

## Status

Accepted **2026-06-22**, consolidating legacy ADR-008.
Amended **2026-06-26**: ExternalId optional only with exact first-party principal pinning.
Amended **2026-08-25**: optional worker principal in target-account trust.
Repository evidence checked **2026-09-13**.

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

## Consequences

One deployment can show registered target accounts, with fan-out latency/quota cost proportional to
scope. Target-role installation remains an operator action. Shared read-only trust is intentionally
broad; no mutation or autonomous mitigation follows from account onboarding.

## Six Pillars

Security: explicit trust and credential scoping. Reliability: direct host access and durable registry.
Operational Excellence: runtime registration. Performance/Cost/Sustainability: scoped queries and
one host rather than a deployment per account.

## Evidence

`web/lib/accounts.ts`, `agent/lambda/cross_account.py`, `infra/cfn/awsops-target-account-role.yaml`,
`terraform/v2/foundation/{workload,network-path,sg-rules}.tf`, and ADR-019.
