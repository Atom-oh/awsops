# terraform/v2/foundation/remediation.tf
# AWSops v2 ADR-029+036 — remediation / mutation execution substrate.
# EVERY resource here is gated by var.remediation_enabled (default false → count=0 → ZERO AWS
# resources, ZERO cost, ZERO live mutation). This EXTENDS the P2 backbone (workers.tf): it reuses
# the worker_jobs Aurora ledger, the SQS queue + dispatcher + status_updater + reaper, and the
# idempotency invariant (SFN execution name == job_id). It adds ONE sibling Step Functions machine
# (remediation), an SSM Automation/Change Manager AWS-resource executor, a per-action P2-code
# executor task role, an S3 Object-Lock audit bucket, an EventBridge SSM status-change resume
# Lambda, and the kill-switch SSM param. Nothing here mutates customer infra until an operator
# flips remediation_enabled, sets the kill-switch true, enables a catalog row, AND a 4-eyes
# approval passes. Design refs: ADR-029 (6 controls) + ADR-036 (hybrid substrate).
locals {
  re             = var.remediation_enabled ? 1 : 0
  rem_src        = "${path.module}/../../../scripts/v2/remediation"
  workers_src_re = "${path.module}/../../../scripts/v2/workers" # reuse db.py/status_updater
  rem_acct       = data.aws_caller_identity.current.account_id
}
