#!/bin/bash
# SessionStart hook: load project context at session start
# Outputs key v2 project stats for Claude's context window

cd "$(dirname "$0")/../.." 2>/dev/null || exit 0

WEB_VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' web/package.json 2>/dev/null | head -1)
echo "# AWSops v2${WEB_VERSION:+ (web v$WEB_VERSION)}"
echo ""

# Git branch and recent changes
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
LAST_COMMIT=$(git log --oneline -1 2>/dev/null || echo "no commits")
echo "Branch: $BRANCH | Last: $LAST_COMMIT"

# Quick project stats (v2 tree: web/app; consolidated ADRs = docs/decisions/0NN-*.md)
PAGE_COUNT=$(find web/app -name 'page.tsx' 2>/dev/null | wc -l)
API_COUNT=$(find web/app/api -name 'route.ts' 2>/dev/null | wc -l)
ADR_COUNT=$(find docs/decisions -name '0*.md' 2>/dev/null | wc -l)
echo "Pages: $PAGE_COUNT | APIs: $API_COUNT | ADRs: $ADR_COUNT"

# Unstaged changes warning
CHANGES=$(git status --porcelain 2>/dev/null | wc -l)
if [ "$CHANGES" -gt 0 ]; then
  echo "Uncommitted changes: $CHANGES files"
fi
