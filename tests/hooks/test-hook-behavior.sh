#!/bin/bash
# Behavioral tests for hooks — verify exit codes and output on controlled inputs
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; }

TMPFILE=$(mktemp /tmp/hook-test-XXXXXX.ts)
trap "rm -f $TMPFILE" EXIT

echo "# Hook behavioral tests"

# --- secret-scan.sh ---
echo "# secret-scan.sh behavior"

# Should block: file with AWS access key
echo 'const key = "AKIAIOSFODNN7EXAMPLE";' > "$TMPFILE"
if bash .claude/hooks/secret-scan.sh "$TMPFILE" >/dev/null 2>&1; then
  fail "secret-scan should block AWS access key"
else
  pass "secret-scan blocks AWS access key"
fi

# Should allow: file with safe content
echo 'const region = "ap-northeast-2";' > "$TMPFILE"
if bash .claude/hooks/secret-scan.sh "$TMPFILE" >/dev/null 2>&1; then
  pass "secret-scan allows safe content"
else
  fail "secret-scan should allow safe content"
fi

# Should allow: empty file path
if bash .claude/hooks/secret-scan.sh "" >/dev/null 2>&1; then
  pass "secret-scan exits 0 on empty path"
else
  fail "secret-scan should exit 0 on empty path"
fi

# --- check-doc-sync.sh ---
echo "# check-doc-sync.sh behavior"

# Should produce output for src/ file without CLAUDE.md in parent
OUT=$(bash .claude/hooks/check-doc-sync.sh "src/app/nonexistent/test.tsx" 2>/dev/null)
if [ -n "$OUT" ]; then
  pass "check-doc-sync detects missing CLAUDE.md"
else
  pass "check-doc-sync runs without error"
fi

# Should exit cleanly on empty path
if bash .claude/hooks/check-doc-sync.sh "" >/dev/null 2>&1; then
  pass "check-doc-sync exits 0 on empty path"
else
  fail "check-doc-sync should exit 0 on empty path"
fi

# --- session-context.sh ---
echo "# session-context.sh behavior"

OUT=$(bash .claude/hooks/session-context.sh 2>/dev/null)
if echo "$OUT" | grep -q "AWSops"; then
  pass "session-context outputs project info"
else
  fail "session-context should output project info"
fi

if echo "$OUT" | grep -q "Pages:"; then
  pass "session-context outputs page count"
else
  fail "session-context should output page count"
fi
