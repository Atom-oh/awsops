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

WORK=$(mktemp -d); BIN=$(mktemp -d); DIFF=$(mktemp)
mkdir -p "$WORK/slot"
echo "diff --git a/foo b/foo" > "$DIFF"
: > "$WORK/responded.txt"
i=0
while [ "$i" -lt 16 ]; do
  { printf '\033[38;5;141m> \033[0mfindings\033[0m\n'; head -c 25000 /dev/zero | tr '\0' 'x'; } \
    > "$WORK/slot/model$i-L2.md"
  echo "model$i/L2" >> "$WORK/responded.txt"
  i=$((i + 1))
done

STDIN_SIZE_FILE="$WORK/stdin-size.txt"
cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env bash
wc -c < /dev/stdin > "$STDIN_SIZE_FILE"
echo "Summary: ok"
echo "VERDICT: PASS"
EOF
chmod +x "$BIN/claude"

PATH="$BIN:$PATH" STDIN_SIZE_FILE="$STDIN_SIZE_FILE" bash "$SCRIPT" "$DIFF" "$WORK" 1 "test pr" "$WORK/review.md" \
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

if [ -s "$WORK/synth-stdin.txt" ] && grep -qP '\x1b\[' "$WORK/synth-stdin.txt" 2>/dev/null; then
  fail "ANSI escapes are stripped from panel bundle before reaching chair"
else
  pass "ANSI escapes are stripped from panel bundle before reaching chair"
fi

grep -q "VERDICT: PASS" "$WORK/review.md" 2>/dev/null \
  && pass "chair completes and produces a valid VERDICT" \
  || fail "chair completes and produces a valid VERDICT"

# Second scenario: primary + fallback both fail — must be diagnosable, not a silent dead end.
WORK2=$(mktemp -d); mkdir -p "$WORK2/slot"
echo "x" > "$WORK2/slot/model0-L2.md"; echo "model0/L2" >> "$WORK2/responded.txt" 2>/dev/null
: > "$WORK2/responded.txt"; echo "model0/L2" >> "$WORK2/responded.txt"

cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "boom: connection refused" >&2
exit 1
EOF
chmod +x "$BIN/claude"

PATH="$BIN:$PATH" bash "$SCRIPT" "$DIFF" "$WORK2" 1 "test pr" "$WORK2/review.md" \
  > "$WORK2/synth.log" 2>&1

if [ -f "$WORK2/chair-failed.flag" ]; then
  pass "chair-failed.flag set when both primary and fallback fail"
else
  fail "chair-failed.flag set when both primary and fallback fail"
fi

if [ -s "$WORK2/chair-primary.err" ] && [ -s "$WORK2/chair-fallback.err" ]; then
  pass "primary/fallback stderr kept in separate files (not overwritten)"
else
  fail "primary/fallback stderr kept in separate files (not overwritten)"
fi

if grep -q "connection refused" "$WORK2/review.md" 2>/dev/null; then
  pass "failure stderr excerpt is recorded in the review body (diagnosable from PR comment)"
else
  fail "failure stderr excerpt is recorded in the review body (diagnosable from PR comment)"
fi

[ "$FAILED" -eq 0 ] || exit 1
