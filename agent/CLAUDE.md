# Agent Module

## Role
Strands Agent for AgentCore Runtime. Connects to 9 domain gateways via MCP protocol.

## Key Files
- `agent.py` — Main entrypoint: dynamic Gateway selection via the `payload.gateway` parameter;
  `_resolve_gateway_key`/`_GATEWAY_ALIAS` handle the `observability`→`external-obs` chat-key
  alias and the canonical-vs-`v2-`-prefixed key coexistence shim (see the do-not-"fix" note in
  root `AGENTS.md`).
- `streamable_http_sigv4.py` — MCP StreamableHTTP with AWS SigV4 signing
- `Dockerfile` — Python 3.11-slim, arm64, port 8080
- `requirements.txt` — strands-agents, boto3, bedrock-agentcore, psycopg2-binary
- `lambda/` — Lambda source files (see `agent/lambda/CLAUDE.md` for the current provisioner and
  tool-inventory sources)

## Gateways and routes — don't hand-count them here
The gateway count, per-gateway tool counts, and the chat routing-key list have drifted stale in
this file before (9 domain gateways incl. `external-obs`; 16 chat-section keys). Rather than
re-introduce a hand-maintained table that goes stale again, read the actual source:
- Gateway/tool inventory: `scripts/v2/agentcore/catalog.py` (the live v2 provisioner catalog)
  and `ai.tf`'s `local.agent_lambdas`.
- Chat routing keys: `web/lib/route.ts`'s `RULES` (regex fast-path, first-match-wins) — the
  `observability` key aliases to the `external-obs` gateway per ADR-004.
- Root `CLAUDE.md`'s "AI (AgentCore)" bullet has the current-truth summary of both.

## Multi-Route Support
- The classifier returns 1–3 routes.
- Parallel gateway calls + result synthesis.
- Real-time response delivery via SSE streaming.

## Rules
- Docker image must be arm64 (`docker buildx --platform linux/arm64`).
- Gateway URL is selected dynamically from the `GATEWAYS` dict based on the payload.
- The system prompt is role-specific, one per domain gateway.
- Fallback: if the MCP connection fails, run without tools — direct Bedrock call.
