# ADR-013: Alert Ingress, Notifications, and Downloads

## Status

Accepted **2026-06-22**, consolidating legacy ADRs 012, 014, and 022.
Amended **2026-08-31** for admin test publishing, **2026-09-01** for runtime pause/durable outcomes,
and **2026-09-02** for compliance completion notifications. Repository evidence checked **2026-09-13**.
The baseline records SNS notification enabled **2026-08-11**; deployment was not rechecked here.

## Context

Machine alert senders cannot carry Cognito browser sessions. Outbound summaries and report downloads
also need explicit controls without treating every communication as infrastructure mutation.

## Decision

### Machine ingress

`/api/incidents/webhook` is an intentional alternate-auth public path. Its first gate is
`INCIDENT_LIFECYCLE_ENABLED`; disabled returns 503 before authentication, triage, or enqueue.
When enabled, bound the body and rate-limit requests, then authenticate by envelope:

- SNS envelopes require SNS signature verification and an enabled ingress integration's TopicArn
  allowlist. Only then may subscription confirmation fetch an SNS-host URL with a bounded timeout.
- Direct POSTs accept configured active/standby bearer tokens or HMAC-SHA256 over the raw body,
  using constant-time comparison. Secrets come from encrypted SSM parameters, not local config files.
- Source hints/headers do not choose the authentication scheme. Missing/invalid credentials fail closed.
  Normalize after authentication and discard AWSops write-back echoes before enqueue.

The implemented bearer/SNS branches are part of the current route; the older HMAC-only description
was incomplete. This clarification does not widen the public-path list or enable incident execution.
Lifecycle remains analysis-only under ADR-006.

### Single-topic communication

`diagnosis_notify_enabled` defaults false. When configured, report/digest and compliance workers
publish to the dedicated SNS topic. Admin subscription management and admin test sending are scoped
to that topic; unsubscribe validates topic ownership. The **2026-08-31** web-role Publish grant
covers only that test path. Broad SaaS writes retain their separate ADR-007 gate.

The admin-only `diagnosis_notify_paused` setting is a convenience control sampled at execution time.
Paused/missing-topic digest work is marked drained, not queued for later resend. A failed pause read
logs and fails open to publishing. Admin test sends intentionally bypass pause. Unsubscribe or disable
the Terraform notification feature for the documented hard stop; pause is not that guarantee.

Persist `notify_outcome` with notification state. `emailed` means SNS returned a MessageId (publish
acceptance, not final mailbox delivery); retain `emailed_failopen`, `publish_failed`, `dropped_paused`,
and `skipped_no_topic`. Failed publish still drains and does not trigger resend.

Compliance completion uses the same topic and pause semantics after successful persistence. Claim
its 60-minute per-benchmark dedup window atomically **before** publishing; preserve the claim on
failure and do not overwrite prior delivery outcomes on re-drive. `skipped_dedup` records suppression.
The message attribute identifies compliance notices; no additional topic or general write authority is implied.

### Downloads

`/api/diagnosis/[id]/download` verifies the user and report access, then proxies the authorized S3
artifact with attachment headers. Do not expose a reusable presigned download URL or rely on edge
JWT verification alone for ownership/revocation. Missing best-effort PDF/DOCX exports are distinct
from a failed Markdown report (ADR-008).

## Consequences

Machine authentication stays separate from browser sessions; single-topic notification limits its
communication surface. Secret rotation, SNS trust, dedup, and irreversible delivery remain operational
responsibilities. BFF-proxied downloads depend on the app and inherit ADR-002's bounded revocation behavior.

## Six Pillars

Security: authenticated ingress and owned artifacts. Operational Excellence: scoped notifications and
durable outcomes. Reliability: rotation support, dedup, and explicit delivery/failure semantics.

## Evidence

`web/app/api/incidents/webhook/route.ts`, `web/lib/incident-ingress-auth.ts`,
`web/lib/diagnosis-notify.ts`, `web/app/api/diagnosis/`, `scripts/v2/workers/diagnosis_digest.py`,
`scripts/v2/workers/compliance.py`, `terraform/v2/foundation/notify.tf`.
