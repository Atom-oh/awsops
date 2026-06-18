<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 5eea181eeb83 · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

## Module: auto-collect agents (v1, `src/`)

Parallel data collectors for the alert-triggered AI diagnosis pipeline (ADR-009). Each file implements the `Collector` interface from `types.ts`, pulling from Steampipe, CloudWatch, K8s, Prometheus, Loki, Tempo/Jaeger, and ClickHouse, then formatting context for Bedrock analysis. One collector per concern (incident, eks/db/msk-optimize, network-flow, trace-analyze, idle-scan).

**Scope note:** This is v1 (`src/`, Steampipe + CDK/EC2). It is the legacy production line. v2 (`web/`, `terraform/v2/`) is a separate rebuild — do not apply v1 patterns there, and don't flag v2 conventions as missing here.

## Interface contract
A `Collector` exposes `collect(send, accountId?, isEn?, alertContext?)`, `formatContext(data)`, plus `analysisPrompt` and `displayName`. Reviewers should hold new/changed collectors to this exact shape.

## Architectural boundaries
- `types.ts` owns the shared interfaces (`Collector`, `CollectorResult`, `AlertContext`, `SendFn`). Collectors depend on it, not vice versa.
- Collector *selection* lives in `alert-diagnosis.ts` (strategy-driven, runs only a subset per alert kind). Individual collectors must not own selection logic.
- A new collector MUST be registered in `alert-diagnosis.ts`'s `COLLECTOR_REGISTRY` — otherwise it is dead code.

## Conventions a reviewer must enforce
- All external-source calls run **in parallel** (`Promise.all([...])`) — reject sequential awaits across independent sources.
- **Missing-datasource = skip, not fatal.** A collector must keep running when one source (e.g. Prometheus) is absent; an absent metric must never abort the pipeline.
- Progress streams via `send(event, data)` (SSE) with `tool_use` / `section` events for live UI.
- Prometheus queries are **candidate arrays** (`queries: [...]`) tried in order, first success wins — not a single hardcoded query.
- Tool-usage summaries accumulate into `viaSummary` (surfaced in the UI `via:` field).
- When `AlertContext` is provided, scope to the alert's services/resources/namespaces instead of a full environment scan (prevents unrelated alarms from diluting analysis).

## Gotchas / banned patterns
- A collector that hard-fails on one missing source breaks the whole diagnosis run — banned.
- Don't bypass `types.ts` interfaces or duplicate the `Collector` shape ad hoc.
- Don't add a collector without the `COLLECTOR_REGISTRY` entry.
- DB access in this tree goes through the shared Steampipe helpers (`runQuery`/`batchQuery`), never the Steampipe CLI; keep SQL out of the collectors where a `queries/*.ts` file already owns it.
