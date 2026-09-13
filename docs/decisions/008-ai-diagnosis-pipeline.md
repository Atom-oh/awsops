# ADR-008: AI Diagnosis Pipeline

## Status

Accepted **2026-06-22**; amended **2026-06-24** and **2026-08-11**.
Consolidates legacy ADRs 013, 016, 019, 021, 033, and 045.
Repository evidence checked **2026-09-13**.

## Context

Diagnosis combines infrastructure evidence into a report with explicit coverage and uncertainty.
Evidence collection, render orchestration, formats, and cost controls must describe the worker path
rather than historical v1 implementations or the separate chat agent loop.

## Decision

- Collect evidence per source, narrowing to requested scope and running bounded independent work in
  parallel. Missing/unavailable sources are nonfatal but must appear in coverage notes. Never invent
  missing evidence or turn recommendations into AWS-resource execution.
  Keep collector coverage separate from invariant-assessment coverage: unassessed is never a pass.
- Run report generation in the asynchronous worker tier. `diagnosis/report.py` uses direct boto3
  Bedrock `invoke_model`; it is not a Strands agent. Render sections with bounded concurrency,
  timeouts, deterministic ordering, and partial-result handling.
- Model choices follow latency/depth and budget. Sonnet is the worker default; deep reports may
  explicitly select Opus. Classification/query generation uses its own configured lightweight model.
  Exact IDs and inference profiles come from `report.py`, `agent.py`, and Terraform; they are not
  permanent policy constants. Preserve `global.*` profile/invocation-log attribution until a measured
  change justifies another configuration.
- Markdown is the report source. Generate/upload DOCX and PDF best effort; export failure does not
  fail a completed Markdown report. Use the same report structure for the export surfaces.
- Chat SSE progress is separate from diagnosis section-token streaming. The worker persists section
  progress; direct report calls do not implement model-output streaming. Do not promise streaming
  simply because progress updates or an SSE chat endpoint exist.
- Prompt caching is implemented on the gateway/Strands path through `CacheConfig` with compatibility
  fallback. Direct classification/synthesis/report calls do not inherit it. The **2026-08-11**
  correction reversed an earlier incorrect attribution. Semantic answer caching remains deferred.
- `diagnosis_schedule_enabled`, `datasource_diagnosis_enabled`, and `ai_insights_enabled` are separate
  default-off gates for their respective background/evidence features. They do not permit mutation.

### Optional chat-loop experiment

`ANTHROPIC_AGENT_LOOP_ENABLED` is a default-off runtime experiment using `AsyncAnthropicBedrock`.
It targets tool-loop debuggability, not a promised speedup for single-shot report calls. Use Bedrock
credentials/profiles and existing governed gateway MCP tools. Preserve read-only filtering in both
loops. The runtime's per-request `agentLoop` override is server-controlled: the BFF must not forward
an untrusted client's choice. This is not permission for arbitrary BYO-MCP or direct API-key model access.

## Consequences

Bounded parallel rendering reduces sequential delay and isolates section failures, but still consumes
model quota. Multiple export formats add maintenance; a report can succeed without every export.
Coverage notes and model configuration are part of the diagnosis contract. Deferred streaming/caching
work is not a reviewer requirement to implement in unrelated changes.

## Six Pillars

Operational Excellence and Reliability: evidence, coverage, deterministic report structure, and failure
isolation. Cost/Performance/Sustainability: bounded model work and targeted caching. Security:
read-only recommendations and governed datasource access.

## Evidence

`scripts/v2/workers/diagnosis/{report,sections,sources,invariants,exporters}.py`,
`scripts/v2/workers/handlers.py`, `agent/agent.py`, `agent/anthropic_loop.py`, `web/lib/agentcore.ts`,
`web/app/api/chat/route.ts`, and ADR-009/012/018.
