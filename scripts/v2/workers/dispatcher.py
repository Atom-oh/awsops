"""SQS-triggered dispatcher: validate the job type, start ONE Step Functions execution per message.
Idempotent on execution name (== job_id) -> ExecutionAlreadyExists is success (SQS at-least-once
redelivery). Returns batchItemFailures (ReportBatchItemFailures) so ONLY genuinely-failed messages
are retried/DLQ'd. No Aurora access here: the web route already inserted the 'queued' row; the
worker/status_updater own all status writes. The SQS ESM is the kill-switch (disable = pause dispatch)."""
import json
import os
import boto3
import handlers

_sfn = boto3.client("stepfunctions", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_SM_ARN = os.environ["STATE_MACHINE_ARN"]


def lambda_handler(event, _ctx):
    failures = []
    for rec in event.get("Records", []):
        msg_id = rec["messageId"]
        job_id = None
        try:
            body = json.loads(rec["body"])
            job_id, type_ = body["job_id"], body["type"]
            if not handlers.is_allowed(type_):
                # Disallowed/unknown type is a client error: it will NEVER succeed, so drop (do not
                # retry into an infinite loop / DLQ). Logged for triage. The web route validates too.
                print(f"DROP unknown type={type_} job_id={job_id}")
                continue
            _sfn.start_execution(
                stateMachineArn=_SM_ARN,
                name=job_id,  # idempotent: execution name == job_id
                input=json.dumps({
                    "job_id": job_id,
                    "type": type_,
                    "payload": body.get("payload", {}),
                    "dry_run": bool(body.get("dry_run", False)),
                    "runtime": handlers.runtime_for(type_),  # SFN Choice routes on this
                }),
            )
        except _sfn.exceptions.ExecutionAlreadyExists:
            # Already started for this job_id (redelivery): success, no retry.
            print(f"DUP execution exists job_id={job_id}")
        except Exception as e:  # noqa: BLE001 - any other error -> retry this one message, then DLQ
            print(f"FAIL msg={msg_id} job_id={job_id}: {e}")
            failures.append({"itemIdentifier": msg_id})
    return {"batchItemFailures": failures}
