# Async Workers

Policy: [BASELINE](../decisions/BASELINE.md). The worker tier separates long or
memory-intensive execution from web processes; it still shares backend dependencies.

```text
Authorized domain route -> worker_jobs + SQS -> dispatcher -> Step Functions
  -> Lambda or Fargate -> worker records outcome in Aurora
  -> Catch invokes status_updater; reaper reconciles stale records
```

## Submission and execution

[web/lib/jobs.ts](../../web/lib/jobs.ts) writes the durable ledger before SQS
send. Requester-scoped idempotency replays the ledger's type/payload/dry-run values,
not replacement client input. A delivery failure preserves the queued row and
raises `EnqueueDeliveryError`. Web enqueues remove scheduler-only provenance.
Generic `/api/jobs` accepts its noop allowlist; domain jobs use routes that verify
authorization and ownership. Trusted schedulers have separate internal enqueue paths.

[dispatcher.py](../../scripts/v2/workers/dispatcher.py) has no DB access.
Registered job types route through [handlers.py](../../scripts/v2/workers/handlers.py);
`StartExecution(name=job_id)` deduplicates transport redelivery and partial batch
failures retry only the affected SQS messages. Separate action/incident state-machine
branches remain governed by their own configuration and product gates. Their
presence is not permission to enable frozen remediation.

[sfn.asl.json](../../scripts/v2/workers/sfn.asl.json) selects Lambda or
`ecs:runTask.sync`. Workers claim/start and finish their own rows through
[db.py](../../scripts/v2/workers/db.py), using IAM authentication as `awsops_worker`.
Claims accept queued/running retries; terminal outcomes are immutable and
`awaiting_approval` remains unclaimable. This is not a general exactly-once
side-effect guarantee; handlers still need appropriate idempotency.

The Catch path invokes a VPC-attached status updater. This state machine does not
write SQL directly. Aurora Data API is enabled for agent readers, so its absence
is not the reason for this worker design. SFN can briefly remain RUNNING after
the worker records success; the application ledger supplies job status.

## Configured limits and recovery

| Boundary | Checked-in configuration |
| --- | --- |
| Dispatcher timeout / queue visibility | 60 seconds / 180 seconds |
| Worker Lambda / SFN Lambda task timeout | 900 seconds / 960 seconds |
| SFN Fargate task timeout | 3,600 seconds |
| Reaper schedule | Every 5 minutes |
| Terraform reaper thresholds | Queued 30 minutes; running 75 minutes |

Keep the running threshold longer than legitimate execution time. Values come
from [workers.tf](../../terraform/v2/foundation/workers.tf) and the ASL; inspect
both when changing timeouts. The reaper also reconciles domain rows, including
reports and analysis runs; do not assume a worker ledger update fixes every domain.

The SQS event-source mapping is the dispatch pause switch. Terraform ignores
operational changes to `enabled`. Pausing does not stop already-started work and
pollers may drain. Queued reaping is skipped when the mapping is confirmed disabled;
a lookup failure currently follows the enabled/fail-open path. Running-job reaping
continues. Follow the operator's scope before toggling this control.

## Packaging and observability

`make workers` builds/pushes an arm64 image after worker infrastructure exists;
Fargate tasks pull it on demand. Use Docker `CMD`, because SFN overrides must
replace the command. DB-using Lambdas share the vendored pg8000 layer and service
SG. Inspect Terraform role/layer wiring instead of copying an old Lambda count.

Powerpipe compliance uses the configured Steampipe backend inside the worker.
SNS notification and other external-data paths retain their own governance; the
AWS mutation freeze does not prohibit all application persistence or notifications.
[Observability](observability-e2e.md) describes job timing, coverage, and remaining
integration limits. Runtime timestamps are migration-owned, not guessed from
`updated_at`.
