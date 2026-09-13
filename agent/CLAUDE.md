# Agent Runtime

Read root [CLAUDE.md](../CLAUDE.md) and
[BASELINE.md](../docs/decisions/BASELINE.md) for policy. This module runs the
Strands AgentCore runtime; `agent.py` selects gateways and streams responses.

## Sources and checks

- Runtime routing/filters: `agent.py`; account selection: `account_utils.py`.
- Gateway/tool wiring: `scripts/v2/agentcore/catalog.py`, `provision.py`, and
  `terraform/v2/foundation/ai.tf`. Chat routing belongs to `web/lib/route.ts` and
  `web/app/api/chat/route.ts`; do not duplicate their inventories here.
- Transport: `streamable_http_sigv4.py`. Keep the Dockerfile and requirements
  consistent; deployed images remain arm64.
- From the repository root: `cd agent && python3 -m pytest test_agent.py test_readiness.py -q`.
  Run additional affected suites in isolation as `scripts/v2/merge-verify.sh` does.

## Contracts

- `readiness.py` requires `DEPLOYMENT_READINESS_ENABLED=true` (default off, from applied
  provisioning output, never caller payload). Its `deployment_readiness` branch checks: runtime STS account,
  curated inventory tools through the existing Ops gateway, a known fresh CloudFront
  record and a bounded model call. Return strict nonce/account-bound evidence without
  inventory data in the model prompt. Failures never fall through to normal chat.

- Preserve the `observability` to `external-obs` alias and canonical/`v2-` gateway
  key compatibility in `_resolve_gateway_key()` while both discovery paths exist.
- Host-account requests use execution credentials. Preserve `effective_account_id()`
  and the host short-circuit in `lambda/cross_account.py`; do not self-assume the
  target-account role on the host.
- Normal chat tool discovery/connection failures before streaming may fall back to a tool-less
  answer. After output starts, do not replay an answer through that fallback.
- Multi-gateway synthesis in the BFF requires both `hybrid_routing_enabled` and
  `multi_route_synthesis_enabled`; selecting candidate routes does not imply fan-out.
- Preserve runtime tool allowlists and server-controlled experimental gates. AWS
  mutation/autonomy and arbitrary BYO-MCP remain FROZEN. Governed external-data
  connectors follow BASELINE; an external write is not automatically AWS mutation.
- Obtain credentials from managed secret/config sources; do not embed secrets in
  source or expose them to prompts/logs. App language behavior remains unchanged.
