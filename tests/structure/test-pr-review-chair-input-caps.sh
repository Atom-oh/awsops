#!/bin/bash
# Guard: chair input must stay bounded even as the lens×model matrix grows, and a chair
# failure (primary+fallback both timeout/error) must leave a diagnosable trail instead of a
# silent 151-byte "review generation failed" (found via failed-run audit of
# Atom-oh/awsops#199 sibling runs — chair Fable 5 hit its 600s cap on a normal-size PR because
# per-cell caps had no total ceiling, and both primary/fallback stderr shared one file so the
# real cause was unrecoverable from the CI log).
cd "$(dirname "$0")/../.."

FAILED=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; FAILED=$((FAILED+1)); }

echo "# pr-review chair input caps + failure diagnostics"

SCRIPT="scripts/pr-review/synthesize.sh"
if [ ! -f "$SCRIPT" ]; then
  fail "synthesize.sh exists"
  exit 1
fi
PRIMARY_MODEL="test-primary"
FALLBACK_MODEL="test-fallback"
AWS_KEY_LEFT="AKIA12345678"
AWS_KEY_RIGHT="90ABCDEF"
FAKE_AWS_KEY="${AWS_KEY_LEFT}${AWS_KEY_RIGHT}"

WORK=$(mktemp -d); BIN=$(mktemp -d); DIFF=$(mktemp)
mkdir -p "$WORK/slot"
echo "diff --git a/foo b/foo" > "$DIFF"
: > "$WORK/responded.txt"
i=0
while [ "$i" -lt 16 ]; do
  {
    printf '\033[38;5;141m> \033[0mfindings\033[0m\n'
    printf 'split credential: %s\033[31m%s\n' "$AWS_KEY_LEFT" "$AWS_KEY_RIGHT"
    printf '\033]0;osc-bel\007OSC-BEL\n'
    printf '\033]0;osc-st\033\\OSC-ST\n'
    printf '\033(BCHARSET\rSPINNER\n'
    head -c 25000 /dev/zero | tr '\0' 'x'
  } \
    > "$WORK/slot/model$i-L2.md"
  echo "model$i/L2" >> "$WORK/responded.txt"
  i=$((i + 1))
done
: > "$WORK/chair-failed.flag"
echo "stale primary error" > "$WORK/chair-primary.err"
echo "stale fallback error" > "$WORK/chair-fallback.err"
GITHUB_ENV_FILE="$WORK/github-env.txt"

STDIN_SIZE_FILE="$WORK/stdin-size.txt"
cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env bash
wc -c < /dev/stdin > "$STDIN_SIZE_FILE"
echo "Summary: ok"
echo "VERDICT: PASS"
EOF
chmod +x "$BIN/claude"

PATH="$BIN:$PATH" STDIN_SIZE_FILE="$STDIN_SIZE_FILE" \
  CHAIR_PRIMARY_MODEL="$PRIMARY_MODEL" CHAIR_FALLBACK_MODEL="$FALLBACK_MODEL" \
  GITHUB_ENV="$GITHUB_ENV_FILE" \
  bash "$SCRIPT" "$DIFF" "$WORK" 1 "test pr" "$WORK/review.md" \
  > "$WORK/synth.log" 2>&1

if grep -q "Argument list too long" "$WORK/synth.log"; then
  fail "16-cell x 25KB panel does not overflow argv (chair reads via stdin)"
else
  pass "16-cell x 25KB panel does not overflow argv (chair reads via stdin)"
fi

if [ -s "$WORK/stdin-size.txt" ]; then
  STDIN_BYTES="$(cat "$WORK/stdin-size.txt")"
  if [ "$STDIN_BYTES" -gt 0 ] && [ "$STDIN_BYTES" -lt 210000 ]; then
    pass "panel bundle respects total cap (~200KB, was 400KB uncapped)"
  else
    fail "panel bundle respects total cap (~200KB, was 400KB uncapped): stdin was ${STDIN_BYTES}B"
  fi
else
  fail "panel bundle respects total cap (~200KB, was 400KB uncapped): stdin size file missing"
fi

if [ -s "$WORK/synth-stdin.txt" ] && LC_ALL=C grep -q "$(printf '\033')\[" "$WORK/synth-stdin.txt"; then
  fail "ANSI escapes are stripped from panel bundle before reaching chair"
else
  pass "ANSI escapes are stripped from panel bundle before reaching chair"
fi

if LC_ALL=C grep -q "$(printf '\033')" "$WORK/synth-stdin.txt" \
  || LC_ALL=C grep -q "$(printf '\r')" "$WORK/synth-stdin.txt"; then
  fail "OSC, ST, charset-select, and bare carriage-return controls are stripped"
else
  pass "OSC, ST, charset-select, and bare carriage-return controls are stripped"
fi

if grep -Fq "$FAKE_AWS_KEY" "$WORK/synth-stdin.txt"; then
  fail "ANSI-split credential is not restored in plaintext after control stripping"
elif grep -Fq "[REDACTED-AWS-KEY]" "$WORK/synth-stdin.txt"; then
  pass "ANSI is stripped before credential scrubbing"
else
  fail "ANSI is stripped before credential scrubbing: redaction marker missing"
fi

grep -q "VERDICT: PASS" "$WORK/review.md" 2>/dev/null \
  && pass "chair completes and produces a valid VERDICT" \
  || fail "chair completes and produces a valid VERDICT"

if [ -f "$WORK/chair-failed.flag" ] \
  || grep -q '^chair_failed=1$' "$GITHUB_ENV_FILE" 2>/dev/null \
  || grep -q "리뷰 생성 실패" "$WORK/review.md" 2>/dev/null; then
  fail "successful chair run clears stale failure state and does not emit the generation-failed badge signal"
else
  pass "successful chair run clears stale failure state and does not emit the generation-failed badge signal"
fi

if grep -q "stale .* error" "$WORK/chair-primary.err" "$WORK/chair-fallback.err" 2>/dev/null; then
  fail "successful chair run clears stale primary/fallback stderr"
else
  pass "successful chair run clears stale primary/fallback stderr"
fi

if grep -Eq 'chair input: diff=[0-9]+B, panel=[0-9]+B, total=[0-9]+B' "$WORK/synth.log"; then
  pass "chair input metrics split diff, panel, and total bytes"
else
  fail "chair input metrics split diff, panel, and total bytes"
fi

# Second scenario: empty slot files must not reduce the fair cap for surviving reviews.
WORK2=$(mktemp -d); mkdir -p "$WORK2/slot"; : > "$WORK2/responded.txt"
i=0
while [ "$i" -lt 16 ]; do
  : > "$WORK2/slot/model$i-L2.md"
  if [ "$i" -lt 4 ]; then
    head -c 25000 /dev/zero | tr '\0' 'y' > "$WORK2/slot/model$i-L2.md"
    echo "model$i/L2" >> "$WORK2/responded.txt"
  fi
  i=$((i + 1))
done
STDIN_SIZE_FILE="$WORK2/stdin-size.txt"
PATH="$BIN:$PATH" STDIN_SIZE_FILE="$STDIN_SIZE_FILE" \
  CHAIR_PRIMARY_MODEL="$PRIMARY_MODEL" CHAIR_FALLBACK_MODEL="$FALLBACK_MODEL" \
  CHAIR_PANEL_TOTAL_CAP=80000 PANEL_CELL_CAP=20000 \
  bash "$SCRIPT" "$DIFF" "$WORK2" 1 "degraded panel" "$WORK2/review.md" \
  > "$WORK2/synth.log" 2>&1

if [ -s "$STDIN_SIZE_FILE" ] \
  && [ "$(cat "$STDIN_SIZE_FILE")" -gt 75000 ] \
  && [ "$(cat "$STDIN_SIZE_FILE")" -lt 90000 ] \
  && grep -q "cells: 4" "$WORK2/synth.log"; then
  pass "fair cap denominator counts only non-empty panel cells"
else
  fail "fair cap denominator counts only non-empty panel cells"
fi

# Third scenario: primary + fallback both fail — must be diagnosable without leaking stderr.
WORK3=$(mktemp -d); mkdir -p "$WORK3/slot"; : > "$WORK3/responded.txt"
echo "x" > "$WORK3/slot/model0-L2.md"
echo "model0/L2" >> "$WORK3/responded.txt"
GITHUB_ENV_FILE3="$WORK3/github-env.txt"

cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
if [ "$ANTHROPIC_MODEL" = "test-primary" ]; then
  printf 'boom: connection refused %s\033[31m%s\n' "$FAILURE_KEY_LEFT" "$FAILURE_KEY_RIGHT" >&2
else
  head -c 495 /dev/zero | tr '\0' 'z' >&2
  printf '%s\n' "$FAILURE_SECRET" >&2
fi
exit 1
EOF
chmod +x "$BIN/claude"

PATH="$BIN:$PATH" FAILURE_SECRET="$FAKE_AWS_KEY" \
  FAILURE_KEY_LEFT="$AWS_KEY_LEFT" FAILURE_KEY_RIGHT="$AWS_KEY_RIGHT" \
  CHAIR_PRIMARY_MODEL="$PRIMARY_MODEL" CHAIR_FALLBACK_MODEL="$FALLBACK_MODEL" \
  GITHUB_ENV="$GITHUB_ENV_FILE3" \
  bash "$SCRIPT" "$DIFF" "$WORK3" 1 "test pr" "$WORK3/review.md" \
  > "$WORK3/synth.log" 2>&1

if [ -f "$WORK3/chair-failed.flag" ]; then
  pass "chair-failed.flag set when both primary and fallback fail"
else
  fail "chair-failed.flag set when both primary and fallback fail"
fi

if [ -s "$WORK3/chair-primary.err" ] && [ -s "$WORK3/chair-fallback.err" ]; then
  pass "primary/fallback stderr kept in separate files (not overwritten)"
else
  fail "primary/fallback stderr kept in separate files (not overwritten)"
fi

if grep -q "connection refused" "$WORK3/review.md" 2>/dev/null; then
  pass "failure stderr excerpt is recorded in the review body (diagnosable from PR comment)"
else
  fail "failure stderr excerpt is recorded in the review body (diagnosable from PR comment)"
fi

if grep -Fq "$FAKE_AWS_KEY" "$WORK3/review.md" \
  || grep -Fq "$FAKE_AWS_KEY" "$WORK3/synth.log" \
  || grep -Fq "AKIA1" "$WORK3/review.md" \
  || grep -Fq "AKIA1" "$WORK3/synth.log" \
  || LC_ALL=C grep -q "$(printf '\033')" "$WORK3/review.md" \
  || LC_ALL=C grep -q "$(printf '\033')" "$WORK3/synth.log"; then
  fail "chair stderr is scrubbed in PR body and primary/fallback warnings"
elif grep -Fq "[REDACTED-AWS-KEY]" "$WORK3/review.md" \
  && grep -Fq "[REDACTED-AWS-KEY]" "$WORK3/synth.log"; then
  pass "chair stderr is scrubbed in PR body and primary/fallback warnings"
else
  fail "chair stderr is scrubbed in PR body and primary/fallback warnings: redaction markers missing"
fi

grep -q '^chair_failed=1$' "$GITHUB_ENV_FILE3" 2>/dev/null \
  && pass "chair failure exports the generation-failed badge signal" \
  || fail "chair failure exports the generation-failed badge signal"

# Fourth scenario: an omitted source path is the fail-closed reason, even if the chair also fails.
GITHUB_ENV_FILE4="$WORK3/github-env-omitted.txt"
PATH="$BIN:$PATH" FAILURE_SECRET="$FAKE_AWS_KEY" \
  FAILURE_KEY_LEFT="$AWS_KEY_LEFT" FAILURE_KEY_RIGHT="$AWS_KEY_RIGHT" \
  CHAIR_PRIMARY_MODEL="$PRIMARY_MODEL" CHAIR_FALLBACK_MODEL="$FALLBACK_MODEL" \
  GITHUB_ENV="$GITHUB_ENV_FILE4" omitted_source_paths="src/oversized.ts" \
  bash "$SCRIPT" "$DIFF" "$WORK3" 1 "omitted source" "$WORK3/review.md" \
  > "$WORK3/synth-omitted.log" 2>&1

if grep -q '^chair_failed=0$' "$GITHUB_ENV_FILE4" 2>/dev/null \
  && ! grep -q '^chair_failed=1$' "$GITHUB_ENV_FILE4" 2>/dev/null; then
  pass "omitted source-path failure takes badge priority over chair infrastructure failure"
else
  fail "omitted source-path failure takes badge priority over chair infrastructure failure"
fi

# Fifth scenario: the two OUTPUT paths. Scrubbing the panel cells and the stderr excerpts is not
# enough — the diff goes into the chair's stdin and the chair's stdout becomes $OUT, which
# pr-review.yml posts verbatim to a PUBLIC PR comment. A PR that accidentally commits a credential
# is exactly this pipeline's input, and a security-lens review quoting "line N hardcodes <key>" is
# the normal, expected behaviour — so both the diff going in and the synthesis coming out must be
# scrubbed. Redaction does not blunt the review: it still says a key is there, just not its value.
WORK5=$(mktemp -d); mkdir -p "$WORK5/slot"; : > "$WORK5/responded.txt"
echo "model0/L2" >> "$WORK5/responded.txt"
echo "clean panel cell" > "$WORK5/slot/model0-L2.md"
DIFF5=$(mktemp)
{
  echo "diff --git a/config.ts b/config.ts"
  echo "+const key = '${AWS_KEY_LEFT}${AWS_KEY_RIGHT}';"
} > "$DIFF5"

# A chair that echoes its own stdin back (the realistic worst case: it quotes the offending line)
# and also emits a credential of its own that never appeared in any input.
cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env bash
cat
printf 'chair also emitted %s on its own\n' "$CHAIR_OWN_SECRET"
echo "VERDICT: PASS"
EOF
chmod +x "$BIN/claude"

PATH="$BIN:$PATH" CHAIR_OWN_SECRET="${AWS_KEY_LEFT}${AWS_KEY_RIGHT}" \
  CHAIR_PRIMARY_MODEL="$PRIMARY_MODEL" CHAIR_FALLBACK_MODEL="$FALLBACK_MODEL" \
  GITHUB_ENV="$WORK5/github-env.txt" \
  bash "$SCRIPT" "$DIFF5" "$WORK5" 1 "output paths" "$WORK5/review.md" \
  > "$WORK5/synth.log" 2>&1

if grep -Fq "$FAKE_AWS_KEY" "$WORK5/review.md" 2>/dev/null \
  || grep -Fq "AKIA1" "$WORK5/review.md" 2>/dev/null; then
  fail "credential in the reviewed diff does not survive into the posted synthesis"
else
  pass "credential in the reviewed diff does not survive into the posted synthesis"
fi

# The chair's own output is the publication boundary: a credential it emits that was never in any
# input must still be redacted, because $OUT is what gets posted.
if grep -Fq "$FAKE_AWS_KEY" "$WORK5/review.md" 2>/dev/null; then
  fail "credential emitted by the chair itself is redacted before posting"
elif grep -Fq "[REDACTED-AWS-KEY]" "$WORK5/review.md" 2>/dev/null; then
  pass "credential emitted by the chair itself is redacted before posting"
else
  fail "credential emitted by the chair itself is redacted before posting: no redaction marker found"
fi

# $WORK is a fixed, runner-global path on non-ephemeral self-hosted runners and persists between
# runs, so no file under it may hold pre-scrub model output after a run finishes — a later job,
# possibly for a different PR by a different author, can read whatever is left there. Resetting at
# start of run does not close that window; not writing the raw output at all does.
LEAKED=""
for f in "$WORK5"/* "$WORK3"/*; do
  case "$(basename "$f")" in
    synth-stdin.txt|review.md) continue ;;  # both are scrubbed by construction, asserted above
  esac
  [ -f "$f" ] || continue
  if grep -Fq "$FAKE_AWS_KEY" "$f" 2>/dev/null || grep -Fq "AKIA1" "$f" 2>/dev/null; then
    LEAKED="$LEAKED $(basename "$f")"
  fi
done
if [ -n "$LEAKED" ]; then
  fail "no unscrubbed credential is left in \$WORK after the run (found in:$LEAKED)"
else
  pass "no unscrubbed credential is left in \$WORK after the run"
fi

# Cancellation mid-chair-call is the realistic case: the call is bounded at CHAIR_TIMEOUT (600s),
# so it is by far the likeliest moment for GitHub to cancel the job. The in-place scrub runs only
# after the call returns, so without a trap a cancel leaves raw stderr in the runner-global $WORK.
WORK6=$(mktemp -d); mkdir -p "$WORK6/slot"; : > "$WORK6/responded.txt"
echo "model0/L2" >> "$WORK6/responded.txt"; echo "cell" > "$WORK6/slot/model0-L2.md"
DIFF6=$(mktemp); echo "diff --git a/x b/x" > "$DIFF6"

# Chair that leaks to stderr immediately, then hangs — so the TERM lands mid-call, before the
# post-call scrub could ever run.
cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'creds %s\n' "$FAILURE_SECRET" >&2
sleep 30
EOF
chmod +x "$BIN/claude"

PATH="$BIN:$PATH" FAILURE_SECRET="$FAKE_AWS_KEY" \
  CHAIR_PRIMARY_MODEL="$PRIMARY_MODEL" CHAIR_FALLBACK_MODEL="$FALLBACK_MODEL" \
  GITHUB_ENV="$WORK6/github-env.txt" \
  bash "$SCRIPT" "$DIFF6" "$WORK6" 1 "cancelled" "$WORK6/review.md" \
  > "$WORK6/synth.log" 2>&1 &
SYNTH_PID=$!
# Wait for the leak to actually be on disk, then cancel — bounded so this can't hang the suite.
for _ in $(seq 1 100); do
  [ -s "$WORK6/chair-primary.err" ] && break
  sleep 0.1
done
kill -TERM "$SYNTH_PID" 2>/dev/null || true
wait "$SYNTH_PID" 2>/dev/null || true

CANCEL_LEAK=""
for f in "$WORK6"/*.err; do
  [ -f "$f" ] || continue
  grep -Fq "$FAKE_AWS_KEY" "$f" 2>/dev/null && CANCEL_LEAK="$CANCEL_LEAK $(basename "$f")"
done
if [ -n "$CANCEL_LEAK" ]; then
  fail "a cancelled run leaves no raw chair stderr on disk (found in:$CANCEL_LEAK)"
else
  pass "a cancelled run leaves no raw chair stderr on disk"
fi

[ "$FAILED" -eq 0 ] || exit 1
