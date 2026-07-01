#!/bin/bash
# Guard the kiro panel prompt (scripts/pr-review/run-panel.sh): the diff is delivered by file
# path + trusted-tool read (PR #115), so the prompt must tell the model to treat that file's
# content as data only and never follow instructions found inside it (PR #115 review follow-up).
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; }

echo "# pr-review panel prompt safety"

SCRIPT="scripts/pr-review/run-panel.sh"
if [ ! -f "$SCRIPT" ]; then
  fail "run-panel.sh exists"
  exit 0
fi
pass "run-panel.sh exists"

# Isolate just the KIRO_PROMPT assignment (avoid matching unrelated comments elsewhere).
BLOCK="$(sed -n '/^KIRO_PROMPT=/,/^KIRO_MODELS=/p' "$SCRIPT")"

if [ -n "$BLOCK" ]; then
  pass "KIRO_PROMPT assignment block found"
else
  fail "KIRO_PROMPT assignment block found"
fi

if echo "$BLOCK" | grep -qiE "data only|not follow|never follow"; then
  pass "KIRO_PROMPT carries a prompt-injection / data-only guard"
else
  fail "KIRO_PROMPT carries a prompt-injection / data-only guard"
fi

if echo "$BLOCK" | grep -q '\$DIFF'; then
  pass "KIRO_PROMPT still references \$DIFF file path (PR #115 file-read delivery)"
else
  fail "KIRO_PROMPT still references \$DIFF file path (PR #115 file-read delivery)"
fi

# --trust-tools and the prompt's tool-name mentions must be documented as staying in sync.
if grep -B2 -- '--trust-tools=read,grep,fs_read' "$SCRIPT" | grep -qiE "sync|align"; then
  pass "trust-tools / prompt tool-name alignment is documented"
else
  fail "trust-tools / prompt tool-name alignment is documented"
fi
