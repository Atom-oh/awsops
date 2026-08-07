#!/bin/bash
# Test hook existence, permissions, and registration
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; }

echo "# Hook existence and permissions"

# Required hooks (v2 set — the src/*-matching v1 hooks were removed 2026-08-07)
for hook in session-context.sh secret-scan.sh pre-commit.sh check-guide-i18n-sync.sh post-build.sh; do
  if [ -f ".claude/hooks/$hook" ]; then
    pass "Hook exists: $hook"
    if [ -r ".claude/hooks/$hook" ]; then
      pass "Hook readable: $hook"
    else
      fail "Hook not readable: $hook"
    fi
  else
    fail "Hook missing: $hook"
  fi
done

# Removed v1 hooks must not come back silently wired
echo "# Removed v1 hooks stay removed"
for hook in check-doc-sync.sh accumulate-pending-guides.sh check-menu-guide-sync.sh post-save.sh; do
  if grep -q "$hook" .claude/settings.json; then
    fail "settings.json still wires removed hook: $hook"
  else
    pass "settings.json does not wire removed hook: $hook"
  fi
done

# Verify settings.json registers hooks
echo "# Hook registration in settings.json"
if [ -f ".claude/settings.json" ]; then
  if grep -q "PostToolUse" .claude/settings.json; then
    pass "PostToolUse hooks registered"
  else
    fail "PostToolUse hooks not registered"
  fi

  if grep -q "check-guide-i18n-sync" .claude/settings.json; then
    pass "check-guide-i18n-sync hook registered"
  else
    fail "check-guide-i18n-sync hook not registered"
  fi
else
  fail ".claude/settings.json missing"
fi
