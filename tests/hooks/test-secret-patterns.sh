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

# Vacuous-pass guard: empty/missing fixtures would run zero assertions and "pass".
for fx in tests/fixtures/secret-samples.txt tests/fixtures/false-positives.txt; do
  if ! grep -q '[^[:space:]]' "$fx" 2>/dev/null; then
    fail "fixture $fx exists and is non-empty"
    exit 1
  fi
done

TMPFILE=$(mktemp /tmp/secret-test-XXXXXX.ts)
trap "rm -f $TMPFILE" EXIT

echo "# Secret pattern true positives"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  [[ "$line" == \#* ]] && continue
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
  echo "$line" > "$TMPFILE"
  if bash "$HOOK" "$TMPFILE" >/dev/null 2>&1; then
    pass "Allowed: ${line:0:30}..."
  else
    fail "False positive: $line"
  fi
done < tests/fixtures/false-positives.txt

exit $(( FAILS > 0 ? 1 : 0 ))
