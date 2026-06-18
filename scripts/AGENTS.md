<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 276eb19c6992 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# `scripts/` — Deployment Scripts (v1 stack)

## What this is
Numbered shell/python scripts that install, configure, and operate the **v1** AWSops stack on an EC2 host (CDK · EC2 · Steampipe/Powerpipe · AgentCore). This is the legacy-production deploy path; the v2 stack uses `scripts/v2/` (Terraform · ECS Fargate · Aurora) and is out of scope for this directory.

## Step model (boundaries)
Steps are numbered and ordered; first deploy runs them in sequence, restart re-runs only the stop→start tail.
- **Local-run steps** (laptop/CI): CDK infra (step 0) and all Cognito / Lambda@Edge resources (steps 5, 8). These touch `us-east-1`.
- **EC2-run steps**: everything else (Steampipe/Powerpipe install, Next.js build+systemd, EKS access, AgentCore 6a–6f, OpenCost, start/stop/verify).
- AgentCore provisioning is split into `06a`–`06f` (runtime → gateways → tools/targets → interpreter → config injection → memory). A deprecated single `06` script still exists; new work goes in the split scripts.
- Wrappers (`setup.sh`/`install-all.sh`) run the steps in order — they should not contain step logic of their own.

## Conventions a reviewer must enforce
- **`set -euo pipefail` in every script** — fail fast, no silent error swallowing.
- **EC2 scripts use paths relative to the project root** via `cd "$(dirname "$0")/.."`; do not assume an absolute HOME-anchored path.
- **Docker builds are arm64 only** — `docker buildx --platform linux/arm64 --load`. Reject any build that omits the arm64 platform.
- **No hardcoded secrets** — sensitive values come from script args or `read` prompts. Flag any inlined credential, token, password, or endpoint.
- **Region pinning**: Cognito and Lambda@Edge logic must stay on `us-east-1`. Flag region drift in steps 5/8.
- AgentCore Runtime updates must pass both `--role-arn` and `--network-configuration` (omitting either breaks the update).
- AgentCore Code Interpreter / Memory **names allow underscores only** — no hyphens.
- Adding a step keeps the numbering scheme intact and updates `ARCHITECTURE.md` plus the step matrix in `CLAUDE.md`.

## Gotchas / banned patterns
- Don't introduce a new monolithic AgentCore setup script — the 6a–6f split is the intended shape; the old single script is deprecated.
- Don't break the local-vs-EC2 split: a step's execution location is part of its contract (CDK + us-east-1 = local; stack services = EC2).
- Don't conflate this v1 EC2/CDK path with v2 — they coexist; v2 deploy tooling (Terraform/Fargate/Aurora) lives elsewhere and follows different rules.
