#!/usr/bin/env bash
# verify-deck.sh — single source of truth for the awsops-intro.pptx CI gates.
# Called by BOTH .github/workflows/merge-verify.yml (pre-merge, static/) and
# deploy-guide.yml (pre-deploy, build/) so the two never drift.
#
# Usage: bash scripts/verify-deck.sh <path-to-deck.pptx>   (cwd = docs-site/)
#
# Gates, in order:
#   1. structure   — non-empty, PK zip magic, ppt/presentation.xml present,
#                    no macros/embedded objects, no symlink entries,
#                    entry-count (500) and uncompressed-size (50MB) caps
#   2. content     — sensitive-identifier scan over all XML/rels (theme excluded
#                    for panose false positives): two passes, tags→space and
#                    tags→empty (the latter concatenates split OOXML <a:t> runs);
#                    grep exit codes handled fail-closed (only exit 1 passes)
#   3. provenance  — rebuild from the reviewed generator (pptxgenjs, lockfile-
#                    pinned, deterministic) and require part-list + full-archive
#                    byte equality (only docProps/core.xml dcterms timestamps
#                    are stripped before diffing)
#   4. rel targets — no TargetMode="External" relationships
#
# Known limits (documented in static/presentation/awsops-intro/README.md):
# embedded images are pixels grep cannot read — provenance pins them to the
# reviewed generator assets, and any asset change must come through code review.
set -euo pipefail

DECK="${1:?usage: verify-deck.sh <path-to-deck.pptx>}"

PATTERN='\b[0-9]{12}\b|arn:aws[a-z-]*:|(AKIA|ASIA)[0-9A-Z]{16}|PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}|[a-z]{2}-[a-z]+-[0-9]_[A-Za-z0-9]{9}|atomai\.click|\.amazonaws\.com|[a-z0-9]{13,14}\.cloudfront\.net|AWSops[A-Za-z]*Role|\b(vpc|sg|subnet|eni|i|vol|ami|snap)-[0-9a-f]{8,17}\b|\b10\.[0-9]+\.[0-9]+\.[0-9]+\b|\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+\b|\b192\.168\.[0-9]+\.[0-9]+\b'

fail() { echo "::error::$1"; exit 1; }

# scan_text <text> <label> — grep exit codes: 0=leak, 1=clean, >=2=scan error.
scan_text() {
  local rc=0
  grep -aqE "$PATTERN" <<<"$1" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then fail "sensitive identifier found in deck ($2)"; fi
  if [ "$rc" -ne 1 ]; then fail "deck content scan failed ($2, grep exit $rc)"; fi
}

# ── 1. structure ─────────────────────────────────────────────────────────────
test -s "$DECK" || fail "awsops-intro.pptx missing or empty"
[ "$(head -c 4 "$DECK" | od -An -tx1 | tr -d ' \n')" = "504b0304" ] || fail "not a valid zip/pptx container"
# capture listings into variables (no `! cmd | grep` pipelines — immune to a
# future `shell: bash` pipefail override turning SIGPIPE into a bypass)
PARTS=$(unzip -Z1 "$DECK") || fail "cannot list deck zip entries"
MODES=$(unzip -Z "$DECK") || fail "cannot stat deck zip entries"
grep -q '^ppt/presentation\.xml$' <<<"$PARTS" || fail "lacks ppt/presentation.xml — not a real pptx"
if grep -qE 'vbaProject\.bin|^ppt/embeddings/.' <<<"$PARTS"; then fail "deck contains macros or embedded objects"; fi
if grep -q '^l' <<<"$MODES"; then fail "deck zip contains symlink entries"; fi
[ "$(wc -l <<<"$PARTS")" -le 500 ] || fail "deck zip has an implausible number of entries"
TOTAL=$(unzip -l "$DECK" | tail -1 | awk '{print $1}')
[ "$TOTAL" -le 52428800 ] || fail "deck uncompressed size exceeds 50MB cap"

# ── 2. content scan ──────────────────────────────────────────────────────────
# NOTE: the theme/non-XML exclusions here are backstopped by gate 3 (provenance
# pins every part byte-for-byte to generator output) — do not relax gate 3
# independently of widening this scan.
XML=$(unzip -p "$DECK" '*.xml' '*.rels' -x 'ppt/theme/*') || fail "deck XML parts unreadable"
test -n "$XML" || fail "deck content scan extracted zero bytes"
scan_text "$XML" "raw XML"
# tags stripped to EMPTY so text split across OOXML <a:t> runs concatenates
scan_text "$(sed -E 's/<[^>]*>//g' <<<"$XML")" "tag-stripped / split-run"

# ── 3+4. provenance parity + external targets ────────────────────────────────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
node scripts/pptx/build-awsops-intro-pptx.js "$WORK/rebuilt-deck.pptx"
diff <(sort <<<"$PARTS") <(unzip -Z1 "$WORK/rebuilt-deck.pptx" | sort) \
  || fail "pptx part list differs from generator output — extra or missing package parts"
unzip -q "$DECK" -d "$WORK/committed"
unzip -q "$WORK/rebuilt-deck.pptx" -d "$WORK/rebuilt"
# core.xml stays in the diff; strip only its volatile creation/modified stamps
sed -i -E 's#<dcterms:(created|modified)[^<]*</dcterms:(created|modified)>##g' \
  "$WORK/committed/docProps/core.xml" "$WORK/rebuilt/docProps/core.xml"
diff -r --no-dereference "$WORK/committed" "$WORK/rebuilt" \
  || fail "committed pptx does not match generator output — run 'node scripts/pptx/build-awsops-intro-pptx.js' and re-commit"
if grep -rl 'TargetMode="External"' "$WORK/committed" --include='*.rels' >/dev/null; then
  fail "deck contains external relationship targets"
fi

echo "Deck verified: structure, content scan (2-pass), generator parity (full archive), no external targets — $DECK"
