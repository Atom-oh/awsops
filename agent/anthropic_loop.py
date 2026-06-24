"""Flag-gated dark-path chat agent loop on the Anthropic SDK's Bedrock client.

Alongside the Strands `Agent` loop in `agent.py`, this module runs the SAME gateway
MCP tools through a custom agentic loop built on `anthropic.AsyncAnthropicBedrock`.
The lever is **tool-loop debuggability** (removing the opacity of the Strands loop),
NOT latency. Default OFF via `ANTHROPIC_AGENT_LOOP_ENABLED`; per-request override via
`payload.agentLoop`. Going through the Bedrock client preserves IAM/VPC/residency and
Bedrock invocation-log cost attribution (no API key). See ADR-008 (amended 2026-06-24)
and BASELINE §2.

Design note (testability): the module top-level imports are stdlib-only so the pure
helpers AND the injected orchestration loop (`drive_anthropic_loop`) are unit-testable
without `anthropic`/`strands`/network. The heavy imports (`agent`, `anthropic`) are
lazy, inside `run_anthropic_loop`.
"""
import asyncio
import logging
import os

# Same model + home region as the Strands path → invocation-log cost attribution intact.
MODEL_ID = "global.anthropic.claude-sonnet-4-6"
BEDROCK_REGION = "ap-northeast-2"
MAX_TOOL_ROUNDS = 8          # hard cap on tool-call rounds (runaway-loop backstop)
MAX_OUTPUT_TOKENS = 4096     # Anthropic Messages API REQUIRES max_tokens on every call
EXTRA_CONTEXT_CAP = 8000     # bound BFF-supplied context (parity with agent.handler)

logger = logging.getLogger(__name__)


def should_use_anthropic_loop(payload):
    """Route decision: env `ANTHROPIC_AGENT_LOOP_ENABLED` is the default; `payload.agentLoop`
    ('anthropic' | 'strands') overrides per-request. Returns True iff the dark path handles it."""
    override = (payload or {}).get("agentLoop")
    if override == "anthropic":
        return True
    if override == "strands":
        return False
    return os.environ.get("ANTHROPIC_AGENT_LOOP_ENABLED", "").strip().lower() == "true"


def _input_schema(tool):
    """Extract a JSON Schema for an MCP tool. Strands wraps it as ``{'inputSchema': {'json': {...}}}``;
    accept that, a flat ``inputSchema``, or attribute forms. Empty/missing → permissive object."""
    spec = getattr(tool, "tool_spec", None)
    schema = None
    if isinstance(spec, dict):
        schema = spec.get("inputSchema") or spec.get("input_schema")
    if schema is None:
        schema = getattr(tool, "inputSchema", None) or getattr(tool, "input_schema", None)
    if isinstance(schema, dict) and isinstance(schema.get("json"), dict):
        schema = schema["json"]  # unwrap Strands' {'json': <schema>}
    if not isinstance(schema, dict) or not schema:
        return {"type": "object", "properties": {}}
    return schema


def mcp_tools_to_anthropic(tools):
    """MCP tool objects → Anthropic ``tools=[{name, description, input_schema}]``, order preserved."""
    out = []
    for t in tools:
        name = getattr(t, "tool_name", None) or (t.get("name") if isinstance(t, dict) else None)
        spec = getattr(t, "tool_spec", None)
        desc = getattr(t, "description", "") or (spec.get("description") if isinstance(spec, dict) else "") or ""
        out.append({"name": name, "description": desc, "input_schema": _input_schema(t)})
    return out


def build_anthropic_messages(history, user_input):
    """Strands history (``[{role, content:[{text}]}]``, last message excluded) + the final
    user_input → Anthropic messages (``[{role, content:[{type:'text', text}]}]``)."""
    msgs = []
    for m in history or []:
        role = m.get("role", "user")
        text = "".join(part.get("text", "") for part in (m.get("content") or []) if isinstance(part, dict))
        msgs.append({"role": role, "content": [{"type": "text", "text": text}]})
    msgs.append({"role": "user", "content": [{"type": "text", "text": user_input}]})
    return msgs


def _block_attr(block, key, default=None):
    """Read ``key`` from a content block that may be a dict (test fakes) OR a typed SDK object."""
    if isinstance(block, dict):
        return block.get(key, default)
    return getattr(block, key, default)


def extract_tool_uses(content_blocks):
    """Pull ``{id, name, input}`` for each ``tool_use`` block in a completed assistant turn.
    Handles BOTH dict-shaped blocks and the SDK's typed content-block objects."""
    uses = []
    for b in content_blocks or []:
        if _block_attr(b, "type") == "tool_use":
            uses.append({
                "id": _block_attr(b, "id"),
                "name": _block_attr(b, "name"),
                "input": _block_attr(b, "input") or {},
            })
    return uses


def tool_result_block(tool_use_id, result, is_error=False):
    """A ``tool_result`` content block carrying the (text-normalized) MCP result."""
    block = {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": [{"type": "text", "text": result if isinstance(result, str) else str(result)}],
    }
    if is_error:
        block["is_error"] = True
    return block


def apply_cache_control(system_blocks, anthropic_tools):
    """Prompt-cache parity with the Strands path (cache_config='auto' + cache_tools): mark the
    LAST system block and the LAST tool with ``cache_control={'type':'ephemeral'}``. No-op on empties."""
    if system_blocks:
        system_blocks[-1]["cache_control"] = {"type": "ephemeral"}
    if anthropic_tools:
        anthropic_tools[-1]["cache_control"] = {"type": "ephemeral"}
