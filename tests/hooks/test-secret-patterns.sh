#!/bin/bash
# Test that secret patterns are detected / not false-positived
# Uses temp files to properly invoke the hook's file-path guard
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
FAILS=0
fail() { echo "not ok - $1"; FAILS=$((FAILS+1)); }

HOOK=".claude/hooks/secret-scan.sh"

if [ ! -f "$HOOK" ]; then
  fail "$HOOK exists (removing the hook must not silently pass the secret contract)"
  exit 1
fi


TMPFILE=$(mktemp /tmp/secret-test-XXXXXX.ts)
trap "rm -f $TMPFILE" EXIT

# Vacuous-pass guard: each fixture loop must run at least one real assertion —
# a missing/empty/comments-only fixture is a failure, not a silent pass.
TP_RAN=0
FP_RAN=0

echo "# Secret pattern true positives"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  [[ "$line" == \#* ]] && continue
  TP_RAN=$((TP_RAN+1))
  echo "$line" > "$TMPFILE"
  if bash "$HOOK" "$TMPFILE" >/dev/null 2>&1; then
    fail "Should detect: $line"
  else
    pass "Detected: ${line:0:30}..."
  fi
done < tests/fixtures/secret-samples.txt

echo "# Secret pattern false positives"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  [[ "$line" == \#* ]] && continue
  FP_RAN=$((FP_RAN+1))
  echo "$line" > "$TMPFILE"
  if bash "$HOOK" "$TMPFILE" >/dev/null 2>&1; then
    pass "Allowed: ${line:0:30}..."
  else
    fail "False positive: $line"
  fi
done < tests/fixtures/false-positives.txt

if [ "$TP_RAN" -ge 1 ] && [ "$FP_RAN" -ge 1 ]; then
  pass "fixtures exercised ($TP_RAN true-positive, $FP_RAN false-positive cases)"
else
  fail "fixtures exercised zero assertions (tp=$TP_RAN fp=$FP_RAN — missing/empty/comments-only fixture)"
fi

exit $(( FAILS > 0 ? 1 : 0 ))
