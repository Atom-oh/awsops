#!/usr/bin/env bash
# Read/grep profile and no-PR-input startup check, retained from the safety branch.
# Quota / agent-fallback classification lives in lib.sh's provider_diagnostic (anchored on the
# agent name); this file owns the profile install, the startup check and the skip reason.
KIRO_AGENT_NAME="pr-review-readonly"
KIRO_AGENT_SRC="$DIR/agents/$KIRO_AGENT_NAME.json"
KIRO_AGENT_TOOLS='["read", "grep"]'
[ -f "$KIRO_AGENT_SRC" ] || { echo "run-panel.sh: kiro agent config missing: $KIRO_AGENT_SRC" >&2; : > "$WORK/coverage-severe.flag"; exit 1; }
if ! python3 - "$KIRO_AGENT_SRC" "$KIRO_AGENT_NAME" "$KIRO_AGENT_TOOLS" <<'PY'
import json, sys
def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate key")
        obj[key] = value
    return obj
ALLOWED_KEYS = {"name", "description", "tools", "allowedTools", "mcpServers", "useLegacyMcpJson", "resources"}
try:
    with open(sys.argv[1]) as source:
        agent = json.load(source, object_pairs_hook=unique_object)
    tools = json.loads(sys.argv[3])
    valid = (set(agent) <= ALLOWED_KEYS and agent["name"] == sys.argv[2]
             and agent["tools"] == tools and agent["allowedTools"] == tools
             and agent["mcpServers"] == {} and agent["resources"] == []
             and agent["useLegacyMcpJson"] is False)
    if not valid:
        raise ValueError("tool configuration")
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(1)
PY
then
  echo "run-panel.sh: invalid read-only agent configuration: $KIRO_AGENT_SRC (expected name=$KIRO_AGENT_NAME, tools=allowedTools=$KIRO_AGENT_TOOLS, no MCP/resources/hooks)" >&2
  : > "$WORK/coverage-severe.flag"; exit 1
fi
KIRO_WORKSPACE="$PWD"
KIRO_AGENT_DST="$KIRO_WORKSPACE/.kiro/agents/$KIRO_AGENT_NAME.json"
KIRO_AGENT_INSTALLED=0
cleanup_kiro_agent() {
  if [ "$KIRO_AGENT_INSTALLED" = 1 ]; then
    rm -f "$KIRO_AGENT_DST"
    rmdir "$KIRO_WORKSPACE/.kiro/agents" 2>/dev/null || true
  fi
}
trap cleanup_kiro_agent EXIT
if [ -e "$KIRO_AGENT_DST" ]; then
  cmp -s "$KIRO_AGENT_SRC" "$KIRO_AGENT_DST" || { : > "$WORK/coverage-severe.flag"; exit 1; }
elif command -v kiro-cli >/dev/null 2>&1; then
  KIRO_AGENT_INSTALLED=1
  mkdir -p "$KIRO_WORKSPACE/.kiro/agents" && cp "$KIRO_AGENT_SRC" "$KIRO_AGENT_DST" \
    || { echo "run-panel.sh: failed to install kiro agent at $KIRO_AGENT_DST" >&2; : > "$WORK/coverage-severe.flag"; exit 1; }
fi

KIRO_PREFLIGHT_OK=0
KIRO_PREFLIGHT_PASSED=0
KIRO_PREFLIGHT_TIMEOUT="${KIRO_PREFLIGHT_TIMEOUT:-120}"
KIRO_PREFLIGHT_PROMPT="Kiro startup check for the PR-review panel. Reply with exactly PONG and nothing else. Do not use any tools."
# The reply must be exactly one line `PONG` once transport decoration is stripped (ANSI, the `> `
# assistant prefix, blank lines, the numeric usage footer — same shape as report_frame.py's
# KIRO_FOOTER). A substring match would accept "I cannot reply with only PONG".
preflight_reply_is_pong() {
  [ "$(strip_controls < "$1" \
        | sed -E 's/^[[:space:]]*>[[:space:]]?//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
        | grep -v '^$' \
        | grep -vE '^▸ (Credits: [0-9]+(\.[0-9]+)? • )?Time: ([0-9]+m )?[0-9]+(\.[0-9]+)?s$' \
        | tr '\n' '|')" = 'PONG|' ]
}
# Reason printed on every withheld Kiro cell's `[skip]` line (see docs/runbooks/pr-review-panel.md).
KIRO_SKIP_REASON="preflight failed"
command -v kiro-cli >/dev/null 2>&1 || KIRO_SKIP_REASON="kiro-cli binary absent"
if command -v kiro-cli >/dev/null 2>&1; then
  PREFLIGHT_DIR="$WORK/kiro-preflight"
  rm -rf "$PREFLIGHT_DIR" && mkdir -p "$PREFLIGHT_DIR" \
    || { : > "$WORK/coverage-severe.flag"; exit 1; }
  for entry in "${KIRO_MODELS[@]}"; do
    m="${entry%%:*}"; tag="${entry##*:}"
    PREFLIGHT_OUT="$PREFLIGHT_DIR/$tag.txt"; PREFLIGHT_ERR="$PREFLIGHT_DIR/$tag.err"
    timeout --kill-after="$KILL_AFTER" "$KIRO_PREFLIGHT_TIMEOUT" kiro-cli chat "$KIRO_PREFLIGHT_PROMPT" \
      --model "$m" --agent "$KIRO_AGENT_NAME" --no-interactive --wrap never \
      > "$PREFLIGHT_OUT" 2> "$PREFLIGHT_ERR" < /dev/null
    PREFLIGHT_RC=$?
    PREFLIGHT_DIAGNOSTIC="$(provider_diagnostic "$PREFLIGHT_ERR")" || PREFLIGHT_DIAGNOSTIC=$'diagnostic_read_error\tDiagnostic parser failed'
    if [ "$PREFLIGHT_RC" -eq 0 ] && [ -z "$PREFLIGHT_DIAGNOSTIC" ] \
        && preflight_reply_is_pong "$PREFLIGHT_OUT"; then
      KIRO_PREFLIGHT_PASSED=$((KIRO_PREFLIGHT_PASSED + 1))
      echo "Kiro preflight passed: $tag (agent $KIRO_AGENT_NAME loaded, no PR input)" >&2
      continue
    fi
    printf '%s\n' "$tag startup check failed (exit $PREFLIGHT_RC); PR input withheld from all Kiro cells." > "$WORK/kiro-preflight.flag"
    : > "$WORK/coverage-severe.flag"
    if [ -n "$PREFLIGHT_DIAGNOSTIC" ]; then
      printf '%s\n' "$PREFLIGHT_DIAGNOSTIC" | scrub_secrets > "$WORK/provider-failure.flag"
      case "$PREFLIGHT_DIAGNOSTIC" in
        usage_limit$'\t'*) cp "$WORK/provider-failure.flag" "$WORK/kiro-quota.flag"; KIRO_SKIP_REASON="monthly quota exhausted at preflight" ;;
        agent_fallback$'\t'*) cp "$WORK/provider-failure.flag" "$WORK/kiro-agent-fallback.flag"; KIRO_SKIP_REASON="agent fallback at preflight" ;;
        *) KIRO_SKIP_REASON="preflight failed: ${PREFLIGHT_DIAGNOSTIC%%$'\t'*}" ;;
      esac
    fi
    echo "::error::Kiro preflight failed for $tag (exit $PREFLIGHT_RC); no PR input sent to Kiro (see docs/runbooks/pr-review-panel.md)" >&2
    tail -25 "$PREFLIGHT_ERR" | strip_controls | scrub_secrets >&2
    break
  done
  [ "$KIRO_PREFLIGHT_PASSED" -eq "${#KIRO_MODELS[@]}" ] && KIRO_PREFLIGHT_OK=1
fi
