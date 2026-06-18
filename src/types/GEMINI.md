<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: df057a72aa51 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Gemini, an external reviewer — project context below.

# Types Module (`src/types`)

Shared TypeScript type definitions for the application. This directory holds only types — no runtime logic, no I/O, no side effects.

## Scope note (v1 vs v2)
This module is part of the **v1 legacy codebase (`src/`)** — the untouched production app (CDK/EC2/Steampipe). It is **not** part of v2 (`web/`, `terraform/v2/`). Do not apply v2 conventions here, and do not pull v2-only concepts into these types.

## Conventions a reviewer must enforce
- **`interface` for object shapes; `type` alias for unions/primitives.** Flag the wrong choice.
- **Co-locate types with their domain** when a type is used by a single module — it does not belong here.
- **Only genuinely cross-module shared types belong in `src/types`.** A type used by exactly one consumer is a smell; push it back to its domain.
- `aws.ts` is the home for AWS/K8s resource shapes (EC2, S3, RDS, Lambda, VPC, IAM, ECS, DynamoDB, Cost, K8s, Trivy) plus chart/stats UI types.

## Boundaries / banned patterns
- This is a leaf module: types should not import runtime code, and other modules import *from* here — never the reverse for logic.
- No values, functions, or constants that carry behavior — keep it declaration-only.
- Watch for accidental duplication: a domain-specific type copied here instead of imported from its source.
