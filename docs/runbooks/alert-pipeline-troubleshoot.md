# Diagnose alert-triggered jobs

v2 incident ingress uses `/api/incidents/webhook` and the asynchronous worker
backbone. The old EC2 SQS poller, in-memory incident state and `data/config.json`
settings are retired.

## Verify each boundary

1. Check the deployed incident feature gate. A disabled path returns 503 before
   accepting, authenticating, normalizing or enqueueing an event; do not bypass it.
2. Check sender authentication. SNS envelopes require signature verification and an
   allowed topic. Direct posts use configured bearer/HMAC verification. Secrets are
   managed configuration; do not print tokens or weaken checks to accept a test.
3. Verify normalized events and the durable job ledger. HTTP acceptance does not
   establish worker execution or completion.
4. Inspect SQS/ESM, dispatcher, Step Functions and worker logs for the same job ID.
   Check catch-handler/reaper status when a worker fails or becomes stale.
5. Inspect diagnosis evidence and assessment coverage. Missing/partial collector
   results and unassessed invariants must remain visible in the report.
6. Diagnose notification delivery separately. SNS diagnosis notifications have a
   specific governed path; broad external writes remain gated off. A failed email
   does not prove the diagnosis itself failed.

Do not clear durable incident/job state by restarting the web service. Keep the
original error, timestamps, source scope and correlation/job identifiers in the
incident record without credentials or raw sensitive payloads.

Sources: `web/app/api/incidents/webhook/route.ts`, `web/lib/incident-ingress-auth.ts`,
`scripts/v2/incident/`, `scripts/v2/workers/`,
[ADR-006](../decisions/006-incident-analysis-only.md),
[ADR-008](../decisions/008-ai-diagnosis-pipeline.md),
[ADR-009](../decisions/009-async-worker-backbone.md),
[ADR-013](../decisions/013-alerting-notification.md).
