# ADR-007: External Data Integration Governance

## Status

Accepted **2026-06-22**. Consolidates legacy ADRs 011, 031 (curated integration scope), 039, 040, and 041.
**The legacy ADR-041 re-scope is an owner override; the multi-AI verdict was PARTIAL on 2026-06-16.**
The external-write outcome was ratified under legacy ADR-040, but retrospectively claiming the
2026-06-11 reversal never covered external endpoints conflicted with that reversal record.
Preserve this qualification; do not recast it as unanimous approval or a new override.

Transport attribution corrected **2026-07-31** following the **2026-07-22** pentest; remote-MCP
controls reconciled **2026-08-05/06** under ADR-017. Repository evidence checked **2026-09-13**.
Amended **2026-10-29**: governed `custom_mcp` (owner clarification **2026-10-11**) and §6 transport rows.

## Context

External observability reads and knowledge/communication writes are data operations. They need explicit
egress, credential, disclosure, and approval controls without reopening AWS-resource mutation.

## Decision

- ADR-005 continues to freeze AWS-resource mutation/autonomous mitigation. This ADR governs external
  data, not infrastructure execution. Models propose inputs; they do not gain independent write authority.
- Permit admin-registered, typed, curated connectors. Ungoverned (arbitrary-form) BYO-MCP registration
  stays retired. Existing read integrations and hosted vendor presets do not authorize arbitrary endpoints.
  The administrator-only `custom_mcp` kind is a governed connector under this ADR (see below).
- Keep notification and broad-write controls separate. `diagnosis_notify_enabled` gates the single-topic
  SNS communication tier (ADR-013); `integrations_write_enabled` gates broader knowledge/comms writes.
  Both default false. The baseline's dated notification ON observation is not proof of current deployment
  and does not imply that broad writes are enabled.
- Broad writes use an independent flag, kill-switch, and no-AWS-mutation IAM, while reusing the shared
  action/workflow controls. They require `agentcore_enabled`, `integrations_enabled`, and `workers_enabled`.
  They must not enable frozen SSM/Change Manager remediation.

### Governed `custom_mcp` (amended 2026-10-29; owner clarification 2026-10-11)

Per the owner clarification of **2026-10-11**, administrator `custom_mcp` registration is a governed
external connector, distinct from the arbitrary BYO-MCP that legacy ADR-041 dropped. Its controls are
what make it governed and are mandatory:

- administrator-only registration;
- per-account enablement (`agent_spaces.enabled_integration_ids`);
- an administrator `exposedTools` ceiling — an empty ceiling exposes nothing;
- a credential the agent resolves through Secrets Manager at connect time, never a value in the request;
- connect-time SSRF checks (see §6).

Runtime activation is gated by the `CUSTOM_MCP_ENABLED` env (`web/lib/custom-mcp-policy.ts`,
`agent/agent.py` `validate_custom_mcp_spec`), which no Terraform variable sets, so it is off in every
Terraform-managed stack (checked against public `samples/dev` @ `5bac16f2`, 2026-10-24). Enabling it
needs a reviewed Terraform gate and release. Known gap: the registration route stores `credentialsRef`
without validating it as the derived Secrets Manager name (`web/app/api/integrations/route.ts`); the
readiness and agent connect paths fail closed on a mismatch. This clarification does not relax the
ADR-017 per-preset host pins, does not authorize AWS-resource mutation or autonomous remediation
(ADR-005), and does not activate gated external writes. Any change that weakens one of these controls,
or an external MCP endpoint path that bypasses them, stays prohibited.

### Broad-write governance

1. Store scoped credentials in Secrets Manager, fetch at runtime, mask responses, and never log secrets.
2. Require destination allowlists, payload limits, server-side DLP/redaction, and audit. Do not export
   credentials or raw inventory/topology/account dumps. A connector that cannot be reliably redacted
   stays draft-only for human transfer.
3. Require a rendered/redacted draft as the dry-run, four-eyes approval or an explicitly logged
   single-operator escape, idempotency, and a paired compensation reference. Compensation is not a
   promise to undo messages already read. The model proposes the payload only.
4. Enablement requires the owner-controlled feature gate, enabled catalog action, allowed destination,
   and dedicated kill-switch. General-user authoring is separately default-off; registration,
   credential management, upload, and enablement remain admin-controlled.
5. Keep durable Aurora and S3 Object Lock audit records. Sharing a workflow does not share the frozen
   mutation tier's authorization.

### §6 Transport, SSRF and private opt-in

`web/lib/ssrf-guard.ts` is the registration-time literal-host/IP guard. General egress
requires HTTPS and a per-account `allowPrivateDatasource` opt-in for private destinations;
loopback, metadata and other always-blocked destinations remain blocked even with opt-in.
Its finite localhost-alias check is not general DNS resolution. DNS and connection-time
protection belong to the selected transport; do not conflate the following paths.

| Path | Actual boundary / remaining limitation |
|---|---|
| `agent/lambda/datasource_http.py` observation reads | HTTP or HTTPS; private destinations supported without a separate private opt-in; always-blocked addresses and redirects rejected; connects to validated IPs with original Host/SNI. Amended 2026-10-29: connection tests run a bounded real query rather than a public health endpoint, explicit instance reads require ID-bound credentials, and response bodies are byte-capped |
| `agent.py:_connect_integration` general egress **read** | Gated by `validate_custom_mcp_spec` (default off); HTTPS, DNS resolve with metadata/always-blocked and private opt-in checks. Amended 2026-10-29: the session connects to the validated IPs, pinned, with original Host/SNI and certificate verification, closing the earlier connect-time rebinding gap |
| Broad external **write** executor | Separate Lambda action executor; it does not call `_assert_host_allowed` from the general read path. Assess destination/DLP/approval controls on the write path itself |
| Hosted vendor MCP (ADR-017) | Catalog host restriction, exact endpoint acknowledgement, runtime fail-closed tool allowlist; managed egress does not inherit in-house IP pinning |

The former hosted-MCP "vendor can add any write tool" gap was closed by the runtime allowlist in
ADR-017. That does not remove the managed-egress destination limitation or waive broad-write governance.
ClickHouse stdio is a different frozen path, not a hosted-preset exception.

## Consequences

Governed data integration is permitted while infrastructure execution remains frozen. External writes
create lasting disclosure and credential-custody risk; inadequate controls require draft-only behavior
or re-freezing. Review controls at their actual call sites rather than attributing a read-path safeguard
to a different write transport.

## Six Pillars

Security: scoped credentials, egress controls, DLP, and human approval. Operational Excellence:
independent gates, auditable compensation, and clear integration ownership. Reliability: isolated
connector failures and explicit draft-only fallback.

## Evidence

`agent/agent.py`, `agent/lambda/datasource_http.py`, `web/lib/custom-mcp-policy.ts`,
`web/app/api/integrations/route.ts`, `terraform/v2/foundation/{variables,remediation}.tf` (public: `terraform/foundation/`),
`scripts/v2/agentcore/{catalog,provision}.py`, ADR-005/013/017, the legacy mapping, and
[external-write ratification](../history/reviews/2026-06-14-external-write-unfreeze-consensus.md).
The ratification pointer does not remove the PARTIAL re-scope qualification above.
