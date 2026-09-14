#!/bin/bash
# Pin the fail-closed contract of the Kiro half of scripts/pr-review/run-panel.sh
# (port of claude-code-usage-dashboard PR #33, adapted to this repo's read-only Kiro cells).
#
# kiro-cli 2.11.1 parses unknown `--trust-tools` names (the empty string, the stale `fs_read`)
# as custom tools, warns once and ignores them, so the flag never pinned this repo's tool grant.
# The grant now lives in agents/pr-review-readonly.json (tools = allowedTools = read, grep) passed
# via `--agent`. Two failure modes must stay visible instead of being counted as empty cells:
#   - agent fallback: "Error: no agent with name X found. Falling back to user specified default"
#     on stderr, rc=0, default agent keeps running -> response discarded, forced FAIL;
#   - monthly quota: "Monthly request limit reached / The limits reset on MM/DD" on stderr,
#     rc=0, empty stdout (v3: rc=1 + JSON MONTHLY_REQUEST_COUNT on stderr) -> no retry, banner.
# Codex stderr may quote those strings (it echoes its input) and must never trigger them.
cd "$(dirname "$0")/../.."

FAILED=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; FAILED=$((FAILED+1)); }
assert_eq() { [ "$2" = "$3" ] && pass "$1" || fail "$1 (expected '$2', got '$3')"; }
assert_file_exists() { [ -f "$2" ] && pass "$1" || fail "$1 ($2 missing)"; }
assert_file_absent() { [ ! -e "$2" ] && pass "$1" || fail "$1 ($2 present)"; }
assert_grep_match() { printf '%s\n' "$3" | grep -qE -- "$2" && pass "$1" || fail "$1 (no match for /$2/)"; }
assert_grep_no_match() { printf '%s\n' "$3" | grep -qE -- "$2" && fail "$1 (unexpected match for /$2/)" || pass "$1"; }

echo "# pr-review panel: Kiro read-only agent, agent-fallback and quota detection"

PANEL="scripts/pr-review/run-panel.sh"
SYNTH="scripts/pr-review/synthesize.sh"
AGENT="scripts/pr-review/agents/pr-review-readonly.json"

bash -n "$PANEL" && pass "run-panel.sh valid bash" || fail "run-panel.sh valid bash"
bash -n "$SYNTH" && pass "synthesize.sh valid bash" || fail "synthesize.sh valid bash"
assert_file_exists "kiro read-only agent config present" "$AGENT"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$AGENT" 2>/dev/null \
  && pass "agent config is valid JSON" || fail "agent config is valid JSON"

AGENT_SUMMARY=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["name"], ",".join(d["tools"]), ",".join(d["allowedTools"]), len(d["mcpServers"]), len(d["resources"]), d["useLegacyMcpJson"], "hooks" in d)' "$AGENT" 2>/dev/null || true)
assert_eq "agent = pr-review-readonly, tools=allowedTools=read,grep, no MCP/resources/hooks" \
  "pr-review-readonly read,grep read,grep 0 0 False False" "$AGENT_SUMMARY"

PANEL_SRC=$(grep -v '^\s*#' "$PANEL")
SYNTH_SRC=$(grep -v '^\s*#' "$SYNTH")
assert_grep_match "run-panel.sh passes --agent \"\$KIRO_AGENT_NAME\" to kiro-cli chat" \
  'kiro-cli chat .*--agent "\$KIRO_AGENT_NAME"' "$(echo "$PANEL_SRC" | tr '\n' ' ')"
assert_grep_match "run-panel.sh installs the agent into the workspace .kiro/agents/" \
  'cp "\$KIRO_AGENT_SRC" "\$KIRO_AGENT_DST"' "$PANEL_SRC"
assert_grep_no_match "run-panel.sh no longer relies on --trust-tools" '\-{2}trust-tools' "$PANEL_SRC"
assert_grep_no_match "run-panel.sh does not use the --v3 engine or --mode (v3-only)" \
  'kiro-cli -{2}v3|-{2}agent-engine|-{2}mode default' "$PANEL_SRC"
assert_grep_match "run-panel.sh logs kiro-cli --version" 'kiro-cli -{2}version' "$PANEL_SRC"
assert_grep_match "run-panel.sh detects the quota signature (v2 stderr)" 'Monthly request limit reached' "$PANEL_SRC"
assert_grep_match "run-panel.sh detects the quota signature (v3 JSON)" 'MONTHLY_REQUEST_COUNT' "$PANEL_SRC"
assert_grep_match "run-panel.sh detects the --agent fallback signature" 'no agent with name' "$PANEL_SRC"
assert_grep_match "run-panel.sh writes kiro-quota.flag" 'kiro-quota\.flag' "$PANEL_SRC"
assert_grep_match "run-panel.sh writes kiro-agent-fallback.flag" 'kiro-agent-fallback\.flag' "$PANEL_SRC"
assert_grep_match "run-panel.sh writes kiro-preflight.flag" 'kiro-preflight\.flag' "$PANEL_SRC"
assert_grep_match "synthesize.sh renders the quota banner" 'kiro-quota\.flag' "$SYNTH_SRC"
assert_grep_match "synthesize.sh renders the agent-fallback banner" 'kiro-agent-fallback\.flag' "$SYNTH_SRC"
assert_grep_match "synthesize.sh renders the preflight banner" 'kiro-preflight\.flag' "$SYNTH_SRC"
assert_file_exists "runbook for the panel failure modes exists" "docs/runbooks/pr-review-panel.md"
grep -q 'pr-review-panel.md' docs/runbooks/CLAUDE.md && pass "runbook is indexed in docs/runbooks/CLAUDE.md" \
  || fail "runbook is indexed in docs/runbooks/CLAUDE.md"

# ---- behaviour with stubbed CLIs (no model calls) -------------------------------------------
if ! command -v timeout >/dev/null 2>&1; then
  echo "# SKIP: timeout(1) not available — stub behaviour not exercised"
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

T_STUB=$(mktemp -d)
trap 'rm -rf "$T_STUB"; rm -f .kiro/agents/pr-review-readonly.json; rmdir .kiro/agents 2>/dev/null' EXIT
mkdir -p "$T_STUB/lenses"
for lens in L2 L3 L4 L5; do echo "LENS: $lens — review only this lens." > "$T_STUB/lenses/$lens.txt"; done
printf 'diff --git a/x b/x\n+x\n' > "$T_STUB/diff.txt"

# Shared stub prologue: --version, and a healthy PONG for the preflight prompt unless the stub
# body overrides it. A healthy review reply is a nonce-bound REVIEW_COMPLETE frame (lib.sh).
STUB_HEAD='#!/bin/bash
[ "${1:-}" = "--version" ] && { echo "kiro-cli 0.0.0-stub"; exit 0; }
PROMPT="${2:-}"
LENS=$(printf "%s\n" "$PROMPT" | sed -n "s/^Review lens: \(L[2-5]\)$/\1/p" | head -1)
NONCE=$(printf "%s\n" "$PROMPT" | sed -n "s/^Cell nonce: \([0-9a-f]\{32\}\)$/\1/p" | head -1)
frame() { printf "> REVIEW_COMPLETE: %s %s {\"report\":\"%s\"}\n" "$LENS" "$NONCE" "$1"; }
is_preflight() { [[ "$PROMPT" == "Kiro startup check"* ]]; }
'
write_kiro_stub() { { printf '%s' "$STUB_HEAD"; cat; } > "$T_STUB/kiro-cli"; chmod +x "$T_STUB/kiro-cli"; }
write_codex_stub() { cat > "$T_STUB/codex"; chmod +x "$T_STUB/codex"; }
run_panel() {
  PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 KIRO_PANEL_TIMEOUT=30 PANEL_RETRIES=2 KIRO_PREFLIGHT_TIMEOUT=30 \
    bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1 || true
}
count_flags() { find "$T_STUB/work" -maxdepth 1 -name '*.flag' | wc -l | tr -d ' '; }

write_codex_stub <<'EOF'
#!/bin/bash
cat > /dev/null
PROMPT="${@: -1}"
LENS=$(printf "%s\n" "$PROMPT" | sed -n "s/^Review lens: \(L[2-5]\)$/\1/p" | head -1)
NONCE=$(printf "%s\n" "$PROMPT" | sed -n "s/^Cell nonce: \([0-9a-f]\{32\}\)$/\1/p" | head -1)
printf 'REVIEW_COMPLETE: %s %s {"report":"no findings"}\n' "$LENS" "$NONCE"
EOF

# 1. Healthy path: preflight PONG + 8 valid frames -> 12/12, no flags, agent copy cleaned up.
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 0; }
frame "no findings"
EOF
OUT=$(run_panel)
assert_grep_match "version is the first stderr line" '^run-panel.sh: kiro-cli 0.0.0-stub' "$(printf '%s\n' "$OUT" | head -1)"
assert_grep_match "healthy run counts all 12 cells" 'Panel responded \(12 / 12 cells\)' "$OUT"
assert_grep_match "both preflights pass" 'Kiro preflight passed: kiro-gpt' "$OUT"
assert_eq "healthy run leaves no flags" "0" "$(count_flags)"
assert_file_absent "runtime agent copy is removed after the run" ".kiro/agents/pr-review-readonly.json"

# 1b. The copy is also removed when the run is cancelled mid-flight (SIGTERM, as with
# cancel-in-progress) — the EXIT trap, not only the happy path after `wait`, owns the cleanup.
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 0; }
sleep 20
frame "no findings"
EOF
# setsid gives the panel its own process group so the stub cells can be terminated with it.
PATH="$T_STUB:$PATH" PANEL_TIMEOUT=30 KIRO_PANEL_TIMEOUT=30 PANEL_RETRIES=1 KIRO_PREFLIGHT_TIMEOUT=30 \
  setsid bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" >/dev/null 2>&1 &
PANEL_PID=$!
for _ in $(seq 1 100); do [ -f .kiro/agents/pr-review-readonly.json ] && break; sleep 0.1; done
assert_file_exists "agent copy is installed while cells run" ".kiro/agents/pr-review-readonly.json"
PANEL_PGID=$(ps -o pgid= -p "$PANEL_PID" 2>/dev/null | tr -d ' ')
kill -TERM "$PANEL_PID" 2>/dev/null; wait "$PANEL_PID" 2>/dev/null
[ -n "$PANEL_PGID" ] && kill -TERM -- "-$PANEL_PGID" 2>/dev/null
assert_file_absent "cancelled run removes the runtime agent copy" ".kiro/agents/pr-review-readonly.json"

# 2. v2 quota (stderr message, rc=0, empty stdout) in review cells: no retry, flag, cause named.
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 0; }
printf 'Monthly request limit reached\nThe limits reset on 10/01.\n' >&2
exit 0
EOF
OUT=$(run_panel)
assert_grep_match "quota cells log [quota]" '\[quota\] kiro-opus-L2 — monthly request limit reached, not retrying' "$OUT"
assert_grep_no_match "quota exhaustion is not retried" '\[retry ' "$OUT"
assert_grep_match "quota ::error:: names the cause and reset date" \
  '::error::Kiro monthly request quota exhausted for KIRO_API_KEY — 8 cell\(s\).*reset on 10/01' "$OUT"
assert_grep_match "codex cells still respond" 'Panel responded \(4 / 12 cells\)' "$OUT"
assert_file_exists "quota leaves kiro-quota.flag" "$T_STUB/work/kiro-quota.flag"
assert_file_exists "quota keeps fail-closed coverage-severe" "$T_STUB/work/coverage-severe.flag"
assert_file_absent "quota does not raise the agent-fallback flag" "$T_STUB/work/kiro-agent-fallback.flag"

# 3. v3-style quota (rc=1, message on stdout, JSON on stderr): stderr-only detection.
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 0; }
echo "You've reached your monthly usage limit."
echo '[ERROR] [KRS] HTTP 400 body={"__type":"...ServiceQuotaExceededException","reason":"MONTHLY_REQUEST_COUNT"}' >&2
exit 1
EOF
OUT=$(run_panel)
assert_grep_no_match "v3-style quota is not retried" '\[retry ' "$OUT"
assert_grep_match "v3-style quota is reported" '::error::Kiro monthly request quota exhausted' "$OUT"
assert_eq "v3-style quota stdout is not counted as a response" "0" "$(cat "$T_STUB"/work/slot/kiro-*.md 2>/dev/null | wc -c | tr -d ' ')"

# 4. Agent fallback in a review cell (rc=0, valid frame from the default agent): discarded.
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 0; }
echo "Error: no agent with name pr-review-readonly found. Falling back to user specified default" >&2
frame "no findings"
exit 0
EOF
OUT=$(run_panel)
assert_grep_match "agent fallback is logged per cell" '\[agent-fallback\] kiro-gpt-L5' "$OUT"
assert_grep_match "agent fallback is reported as ::error::" \
  '::error::kiro-cli ignored --agent pr-review-readonly \(fell back to the default agent\) in 8 cell\(s\)' "$OUT"
assert_grep_match "fallback responses are not counted" 'Panel responded \(4 / 12 cells\)' "$OUT"
assert_file_exists "agent fallback leaves kiro-agent-fallback.flag" "$T_STUB/work/kiro-agent-fallback.flag"
assert_file_exists "agent fallback forces coverage-severe" "$T_STUB/work/coverage-severe.flag"
assert_file_absent "agent fallback does not raise the quota flag" "$T_STUB/work/kiro-quota.flag"

# 5. Preflight fallback: even a PONG reply is rejected and no Kiro review is started.
write_kiro_stub <<'EOF'
is_preflight && { echo "Error: no agent with name pr-review-readonly found. Falling back to user specified default" >&2; echo "> PONG"; exit 0; }
touch "$0.review-started"
frame "no findings"
EOF
OUT=$(run_panel)
assert_file_absent "fallback during preflight prevents every Kiro review" "$T_STUB/kiro-cli.review-started"
assert_grep_match "preflight fallback is reported" '::error::kiro-cli ignored --agent pr-review-readonly during preflight \(kiro-opus\)' "$OUT"
assert_grep_match "preflight failure is reported" '::error::Kiro preflight failed for kiro-opus' "$OUT"
assert_file_exists "failed preflight leaves kiro-preflight.flag" "$T_STUB/work/kiro-preflight.flag"
assert_file_exists "failed preflight leaves kiro-agent-fallback.flag" "$T_STUB/work/kiro-agent-fallback.flag"
assert_file_exists "failed preflight forces coverage-severe" "$T_STUB/work/coverage-severe.flag"
assert_grep_match "codex still reviews when Kiro preflight fails" 'Panel responded \(4 / 12 cells\)' "$OUT"

# 6. Preflight quota: cause is named, no Kiro review is started.
write_kiro_stub <<'EOF'
is_preflight && { printf 'Monthly request limit reached\nThe limits reset on 10/01.\n' >&2; exit 0; }
touch "$0.review-started"
frame "no findings"
EOF
OUT=$(run_panel)
assert_file_absent "quota during preflight prevents every Kiro review" "$T_STUB/kiro-cli.review-started"
assert_grep_match "preflight quota is reported with the reset date" \
  '::error::Kiro monthly request quota exhausted for KIRO_API_KEY \(preflight kiro-opus\).*reset on 10/01' "$OUT"
assert_file_exists "preflight quota leaves kiro-quota.flag" "$T_STUB/work/kiro-quota.flag"
assert_grep_match "skip lines name the preflight quota as the reason" \
  '\[skip\] kiro-gpt/L5 \(monthly quota exhausted at preflight\)' "$OUT"

# 6b. Preflight PONG is an exact comparison after stripping decoration — a refusal that merely
# contains the token, or extra text, must not release PR input; prefix/footer/blank lines are fine.
write_kiro_stub <<'EOF'
is_preflight && { echo "> I cannot reply with only PONG without more context."; exit 0; }
touch "$0.review-started"
frame "no findings"
EOF
OUT=$(run_panel)
assert_file_absent "a reply merely containing PONG cannot release PR input" "$T_STUB/kiro-cli.review-started"
assert_grep_match "non-PONG reply is reported as a preflight failure" '::error::Kiro preflight failed for kiro-opus \(exit 0\)' "$OUT"
write_kiro_stub <<'EOF'
is_preflight && { printf '\033[38;5;141m> \033[0mPONG\n\n\xe2\x96\xb8 Credits: 0.01 \xe2\x80\xa2 Time: 1.2s\n'; exit 0; }
frame "no findings"
EOF
OUT=$(run_panel)
assert_grep_match "PONG with ANSI prefix, blank line and usage footer passes" 'Panel responded \(12 / 12 cells\)' "$OUT"

# 6c. The JSON-invalid fallback signature is anchored on this repo's agent file: another broken
# kiro-cli config on the runner is not mistaken for `--agent` being ignored.
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 0; }
echo "Json supplied at /home/runner/.kiro/settings/mcp.json is invalid" >&2
frame "no findings"
EOF
OUT=$(run_panel)
assert_grep_match "unrelated invalid-JSON stderr keeps the cell" 'Panel responded \(12 / 12 cells\)' "$OUT"
assert_eq "unrelated invalid-JSON stderr leaves no flags" "0" "$(count_flags)"
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 0; }
echo "Json supplied at $PWD/.kiro/agents/pr-review-readonly.json is invalid" >&2
frame "no findings"
EOF
OUT=$(run_panel)
assert_grep_match "invalid agent JSON on stderr is treated as fallback" '\[agent-fallback\] kiro-opus-L2' "$OUT"
assert_file_exists "invalid agent JSON on stderr raises kiro-agent-fallback.flag" "$T_STUB/work/kiro-agent-fallback.flag"

# 7. Preflight with rc!=0 or a non-PONG reply withholds PR input; a later healthy run clears flags.
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 1; }
touch "$0.review-started"
frame "no findings"
EOF
OUT=$(run_panel)
assert_file_absent "PONG with a failed command cannot release PR input" "$T_STUB/kiro-cli.review-started"
write_kiro_stub <<'EOF'
is_preflight && { echo "> PONG"; exit 0; }
frame "no findings"
EOF
OUT=$(run_panel)
assert_eq "a later healthy run clears every stale flag" "0" "$(count_flags)"
assert_grep_match "recovered run counts all 12 cells" 'Panel responded \(12 / 12 cells\)' "$OUT"

# 8. Codex echoing Kiro signatures on stderr is neither a Kiro failure nor a lost review.
write_codex_stub <<'EOF'
#!/bin/bash
cat >&2
echo "Monthly request limit reached / no agent with name pr-review-readonly found" >&2
PROMPT="${@: -1}"
LENS=$(printf "%s\n" "$PROMPT" | sed -n "s/^Review lens: \(L[2-5]\)$/\1/p" | head -1)
NONCE=$(printf "%s\n" "$PROMPT" | sed -n "s/^Cell nonce: \([0-9a-f]\{32\}\)$/\1/p" | head -1)
printf 'REVIEW_COMPLETE: %s %s {"report":"no findings"}\n' "$LENS" "$NONCE"
EOF
printf 'diff --git a/x b/x\n+Monthly request limit reached\n+no agent with name pr-review-readonly found\n' > "$T_STUB/diff.txt"
OUT=$(run_panel)
assert_grep_match "Codex quoting Kiro errors remains a successful response" 'Panel responded \(12 / 12 cells\)' "$OUT"
assert_eq "quoted Kiro errors in Codex stderr leave no flags" "0" "$(count_flags)"

# 9. Invalid agent configuration (duplicate keys / extra tool) aborts before any model call.
mkdir -p "$T_STUB/fixture/agents"
cp "$PANEL" scripts/pr-review/lib.sh scripts/pr-review/report_frame.py "$T_STUB/fixture/"
write_kiro_stub <<'EOF'
touch "$0.chat-invoked"
is_preflight && { echo "> PONG"; exit 0; }
frame "no findings"
EOF
echo '{"name":"pr-review-readonly","tools":["read","grep"],"tools":["read","grep","shell"],"allowedTools":["read","grep"],"mcpServers":{},"useLegacyMcpJson":false,"resources":[]}' \
  > "$T_STUB/fixture/agents/pr-review-readonly.json"
RC=0; OUT=$(PATH="$T_STUB:$PATH" bash "$T_STUB/fixture/run-panel.sh" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1) || RC=$?
assert_eq "duplicate JSON keys are rejected before startup" "1" "$RC"
assert_grep_match "invalid agent config is named in the log" 'invalid read-only agent configuration' "$OUT"
echo '{"name":"pr-review-readonly","tools":["read","grep","shell"],"allowedTools":["read","grep","shell"],"mcpServers":{},"useLegacyMcpJson":false,"resources":[]}' \
  > "$T_STUB/fixture/agents/pr-review-readonly.json"
RC=0; OUT=$(PATH="$T_STUB:$PATH" bash "$T_STUB/fixture/run-panel.sh" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1) || RC=$?
assert_eq "a wider tool grant is rejected before startup" "1" "$RC"
rm -f "$T_STUB/fixture/agents/pr-review-readonly.json"
RC=0; OUT=$(PATH="$T_STUB:$PATH" bash "$T_STUB/fixture/run-panel.sh" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1) || RC=$?
assert_eq "a missing agent file is rejected before startup" "1" "$RC"
assert_file_absent "invalid agent configuration never reaches a model" "$T_STUB/kiro-cli.chat-invoked"

# 10. A failed agent copy aborts before startup.
printf '#!/bin/bash\nexit 1\n' > "$T_STUB/cp"; chmod +x "$T_STUB/cp"
RC=0; OUT=$(PATH="$T_STUB:$PATH" bash "$PANEL" "$T_STUB/diff.txt" "$T_STUB/lenses" "$T_STUB/work" 2>&1) || RC=$?
assert_eq "failed agent copy aborts before startup" "1" "$RC"
assert_grep_match "failed agent copy is named in the log" 'failed to install kiro agent' "$OUT"
assert_file_absent "failed agent copy never reaches a model" "$T_STUB/kiro-cli.chat-invoked"

[ "$FAILED" -eq 0 ] || exit 1
