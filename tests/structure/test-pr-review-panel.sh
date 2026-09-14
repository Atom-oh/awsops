#!/bin/bash
# Pin the static contract of the Kiro half of the PR-review panel (scripts/pr-review/run-panel.sh
# + kiro-safety.sh, ROLE_REVIEW=1): the read-only agent profile, the anchored agent-fallback
# signature, the startup-check/skip-reason plumbing and the three review-comment banners that
# name a Kiro-specific cause (preflight, monthly quota, agent fallback). Behaviour with stubbed
# CLIs is covered offline by scripts/pr-review/test_provider_diagnostics.py (run by
# tests/run-all.sh); this file keeps the file-level contract greppable and the runbook indexed.
cd "$(dirname "$0")/../.."

FAILED=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; FAILED=$((FAILED+1)); }
assert_eq() { [ "$2" = "$3" ] && pass "$1" || fail "$1 (expected '$2', got '$3')"; }
assert_file_exists() { [ -f "$2" ] && pass "$1" || fail "$1 ($2 missing)"; }
assert_grep_match() { printf '%s\n' "$3" | grep -qE -- "$2" && pass "$1" || fail "$1 (no match for /$2/)"; }
assert_grep_no_match() { printf '%s\n' "$3" | grep -qE -- "$2" && fail "$1 (unexpected match for /$2/)" || pass "$1"; }

echo "# pr-review panel: Kiro read-only agent, startup check and cause banners"

PANEL="scripts/pr-review/run-panel.sh"
SAFETY="scripts/pr-review/kiro-safety.sh"
LIB="scripts/pr-review/lib.sh"
SYNTH="scripts/pr-review/synthesize.sh"
AGENT="scripts/pr-review/agents/pr-review-readonly.json"
RUNBOOK="docs/runbooks/pr-review-panel.md"

for f in "$PANEL" "$SAFETY" "$LIB" "$SYNTH"; do
  bash -n "$f" && pass "$(basename "$f") valid bash" || fail "$(basename "$f") valid bash"
done
assert_file_exists "kiro read-only agent config present" "$AGENT"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$AGENT" 2>/dev/null \
  && pass "agent config is valid JSON" || fail "agent config is valid JSON"
AGENT_SUMMARY=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["name"], ",".join(d["tools"]), ",".join(d["allowedTools"]), len(d["mcpServers"]), len(d["resources"]), d["useLegacyMcpJson"], "hooks" in d)' "$AGENT" 2>/dev/null || true)
assert_eq "agent = pr-review-readonly, tools=allowedTools=read,grep, no MCP/resources/hooks" \
  "pr-review-readonly read,grep read,grep 0 0 False False" "$AGENT_SUMMARY"
grep -qxF '.kiro/agents/pr-review-readonly.json' .gitignore \
  && pass "runtime agent copy path is gitignored" || fail "runtime agent copy path is gitignored"

PANEL_SRC=$(grep -v '^\s*#' "$PANEL")
SAFETY_SRC=$(grep -v '^\s*#' "$SAFETY")
SYNTH_SRC=$(grep -v '^\s*#' "$SYNTH")
assert_grep_match "run-panel.sh logs kiro-cli --version" 'kiro-cli -{2}version' "$PANEL_SRC"
assert_grep_match "role mode passes --agent \"\$KIRO_AGENT_NAME\" to kiro-cli chat" \
  'kiro-cli chat .*--agent "\$KIRO_AGENT_NAME"' "$(echo "$PANEL_SRC" | tr '\n' ' ')"
assert_grep_match "role mode does not use the --v3 engine or --mode (v3-only)" \
  'ROLE_REVIEW' "$PANEL_SRC"
assert_grep_no_match "no cell uses the --v3 engine or --mode (v3-only, ignores the agent's tools)" \
  'kiro-cli -{2}v3|-{2}agent-engine|-{2}mode default' "$PANEL_SRC"
assert_grep_match "withheld Kiro cells print a [skip] reason" '\[skip\] \$tag/\$lens \(\$KIRO_SKIP_REASON\)' "$PANEL_SRC"
assert_grep_match "terminal provider failures are logged per cell" '\[provider-failure\]' "$PANEL_SRC"

assert_grep_match "kiro-safety.sh installs the agent into the workspace .kiro/agents/" \
  'cp "\$KIRO_AGENT_SRC" "\$KIRO_AGENT_DST"' "$SAFETY_SRC"
assert_grep_match "kiro-safety.sh removes the installed copy through an EXIT trap" 'trap cleanup_kiro_agent EXIT' "$SAFETY_SRC"
assert_grep_match "preflight compares the stripped reply to exactly PONG" "= 'PONG\|'" "$SAFETY_SRC"
assert_grep_no_match "preflight no longer accepts a PONG substring" "grep -qw 'PONG'" "$SAFETY_SRC"
assert_grep_match "preflight quota sets the skip reason" 'monthly quota exhausted at preflight' "$SAFETY_SRC"
assert_grep_match "preflight fallback sets the skip reason" 'agent fallback at preflight' "$SAFETY_SRC"
assert_grep_match "preflight failure points at the runbook" 'pr-review-panel\.md' "$SAFETY_SRC"
assert_grep_no_match "kiro-safety.sh carries no unused unanchored signature regex" 'KIRO_(QUOTA|AGENT_FALLBACK)_RE=' "$SAFETY_SRC"

assert_grep_match "agent-fallback JSON signature is anchored on the review agent file" \
  'Json supplied at \\S\*pr-review-readonly\\\.json is invalid' "$(cat "$LIB")"
assert_grep_no_match "agent-fallback JSON signature is not the unanchored form" \
  'Json supplied at \.\* is invalid' "$(cat "$LIB")"
assert_grep_match "quota classifier keeps MONTHLY_REQUEST_COUNT" 'MONTHLY_REQUEST_COUNT' "$(cat "$LIB")"

assert_grep_match "synthesize.sh renders the preflight banner" 'kiro-preflight\.flag' "$SYNTH_SRC"
assert_grep_match "synthesize.sh renders the quota banner" 'kiro-quota\.flag' "$SYNTH_SRC"
assert_grep_match "synthesize.sh renders the agent-fallback banner" 'kiro-agent-fallback\.flag' "$SYNTH_SRC"
for banner in 'Kiro preflight failed' 'Kiro monthly request quota exhausted' 'Kiro agent contract broken'; do
  assert_grep_match "banner '$banner' is English-only" "\*\*$banner\*\*" "$SYNTH_SRC"
done
assert_grep_no_match "degraded banner no longer blames the removed --trust-tools flag" 'invalid flag' "$SYNTH_SRC"

assert_file_exists "runbook for the panel failure modes exists" "$RUNBOOK"
grep -q 'pr-review-panel.md' docs/runbooks/CLAUDE.md && pass "runbook is indexed in docs/runbooks/CLAUDE.md" \
  || fail "runbook is indexed in docs/runbooks/CLAUDE.md"
if grep -qP '[\x{AC00}-\x{D7A3}]' "$RUNBOOK" 2>/dev/null; then
  fail "runbook is English-only (docs/runbooks/CLAUDE.md)"
else
  pass "runbook is English-only (docs/runbooks/CLAUDE.md)"
fi
for term in 'Kiro monthly request quota exhausted' 'Kiro agent contract broken' 'Kiro preflight failed' \
            'monthly quota exhausted at preflight' '/demo-platform/actions/AI-key' 'kiro-cli agent validate'; do
  grep -qF -- "$term" "$RUNBOOK" && pass "runbook documents '$term'" || fail "runbook documents '$term'"
done
grep -q 'env -i .*KIRO_API_KEY=' "$RUNBOOK" && fail "runbook does not place KIRO_API_KEY in env's argv" \
  || pass "runbook does not place KIRO_API_KEY in env's argv"

[ "$FAILED" -eq 0 ] || exit 1
