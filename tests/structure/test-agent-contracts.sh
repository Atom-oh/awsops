#!/bin/bash
# Validate .claude/agents/*.md subagent definitions carry the required frontmatter contract.
# (The old *.yml format with output_schema/input/prompt was v1-era — agents are markdown
# with YAML frontmatter now.)
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
FAILS=0
fail() { echo "not ok - $1"; FAILS=$((FAILS+1)); }

echo "# Agent contract validation"

for agent in .claude/agents/*.md; do
  [ ! -f "$agent" ] && continue
  NAME=$(basename "$agent" .md)
  FM=$(sed -n '/^---$/,/^---$/p' "$agent")

  for field in name description tools; do
    if echo "$FM" | grep -q "^$field:"; then
      pass "$NAME has $field field"
    else
      fail "$NAME missing $field field"
    fi
  done

  # Least privilege: review/audit agents stay read-only (no Bash). explorer is the
  # sanctioned exception (needs Bash for read-only git/find surveys).
  if [ "$NAME" != "explorer" ] && echo "$FM" | grep "^tools:" | grep -q "Bash"; then
    fail "$NAME has Bash tool (should be read-only)"
  else
    pass "$NAME tool grant matches its contract"
  fi
done

# Verify at least 1 agent exists
AGENT_COUNT=$(ls .claude/agents/*.md 2>/dev/null | wc -l)
if [ "$AGENT_COUNT" -ge 1 ]; then
  pass "At least 1 agent file exists ($AGENT_COUNT found)"
else
  fail "No agent files found"
fi

exit $(( FAILS > 0 ? 1 : 0 ))
