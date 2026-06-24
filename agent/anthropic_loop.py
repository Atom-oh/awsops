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


def _assistant_content(final):
    """Rebuild a serializable assistant turn (text + tool_use blocks) from a final message,
    so it can be appended to ``messages`` before the tool_result turn. Handles dict/object blocks."""
    out = []
    for b in getattr(final, "content", None) or []:
        t = _block_attr(b, "type")
        if t == "text":
            out.append({"type": "text", "text": _block_attr(b, "text", "") or ""})
        elif t == "tool_use":
            out.append({"type": "tool_use", "id": _block_attr(b, "id"),
                        "name": _block_attr(b, "name"), "input": _block_attr(b, "input") or {}})
    return out


# Fail-soft deltas (mirrors agent.handler's wording for the post-stream case).
_INTERRUPTED_DELTA = "\n\n_[연결이 중단되어 응답이 일부만 전달되었습니다.]_"
_FAILED_DELTA = "_[에이전트 루프 오류로 응답을 생성하지 못했습니다.]_"


async def drive_anthropic_loop(*, aclient, mcp_call, model, system_blocks,
                               anthropic_tools, messages, max_rounds, max_tokens):
    """The agentic loop, with all external effects injected so it is unit-testable with fakes:

      - ``aclient``: AsyncAnthropicBedrock-like; ``aclient.messages.stream(**kwargs)`` returns an
        async context manager exposing ``.text_stream`` (async iterator of str) and
        ``await .get_final_message()`` (→ object with ``.stop_reason`` and ``.content``).
      - ``mcp_call(name, input)``: a SYNC callable that runs ONE tool and returns its result.
        Called off the event loop via ``asyncio.to_thread`` so a blocking MCP call never stalls
        streaming. A per-tool exception becomes an ``is_error`` tool_result (one bad tool does not
        abort the turn).

    Yields ``{"delta": str}``. On ``stop_reason == 'tool_use'`` it runs the tools, appends the
    assistant turn + a ``tool_result`` user turn, and loops. The model is offered tools only while
    ``rounds < max_rounds``; at the cap it makes one final TOOL-LESS synthesis turn and stops —
    never an unbounded loop. Errors are fail-soft (D5): no re-run, no exception escapes.
    """
    started = False
    try:
        msgs = list(messages)
        rounds = 0
        while True:
            offer_tools = bool(anthropic_tools) and rounds < max_rounds
            kwargs = {"model": model, "max_tokens": max_tokens,
                      "system": system_blocks, "messages": msgs}
            if offer_tools:
                kwargs["tools"] = anthropic_tools
            async with aclient.messages.stream(**kwargs) as stream:
                async for text in stream.text_stream:
                    if text:
                        started = True
                        yield {"delta": text}
                final = await stream.get_final_message()

            if not offer_tools or _block_attr(final, "stop_reason") != "tool_use":
                return  # normal completion (or the capped final synthesis turn)

            tool_uses = extract_tool_uses(getattr(final, "content", None) or [])
            if not tool_uses:
                return
            msgs.append({"role": "assistant", "content": _assistant_content(final)})
            results = []
            for tu in tool_uses:
                try:
                    res = await asyncio.to_thread(mcp_call, tu["name"], tu["input"])
                    results.append(tool_result_block(tu["id"], res))
                except Exception as e:  # one tool failing must not abort the turn
                    logger.warning("tool %s failed: %s", tu.get("name"), e)
                    results.append(tool_result_block(tu["id"], f"tool error: {e}", is_error=True))
            msgs.append({"role": "user", "content": results})
            rounds += 1
    except Exception as e:
        logger.error("anthropic loop error (started=%s): %s", started, e, exc_info=True)
        yield {"delta": _INTERRUPTED_DELTA if started else _FAILED_DELTA}
        return
