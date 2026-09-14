## L2 — Code correctness

Scope note: this diff contains no TS/React changes. The reviewable logic is preflight-aws-session.py, the new awk/bash completion validator (lib.sh, run-panel.sh, synthesize.sh) and the Python fixtures that pin them. All line references verified against the base checkout.

### CRITICAL
None.

### MAJOR

1. panel_report_valid discards a completed report whose prose mentions a tool-status pattern (unquoted or inside a fenced block). lib.sh:

awk
if (assistant) in_tool = 0
if (!assistant && (status ~ /\(using tool: [^()]+\)/ || status ~ /✓ Successfully |Summary: [0-9]+ operations processed/)) { lines = 0; in_tool = 1 }


lines is reset, and in_tool can only be cleared by a line starting with >  — which Kiro emits only at the start of a response. So for a real, complete report:

> MAJOR: the body counter is fragile.
A line matching (using tool: read) resets it mid-report.
REVIEW_COMPLETE: L2


line 2 sets in_tool=1, lines=0; line 3 sets last=marker but is not counted → lines > 1 fails → invalid, both attempts, slot truncated, cell dropped. Because this PR also makes all 12 cells mandatory (lens_count -lt TOTAL_MODELS → coverage-severe.flag), one such report forces VERDICT: FAIL for the whole PR. The gsub masking only covers same-line backticks/"/' — a triple-backtick fenced excerpt (the natural way to quote a transcript) is not masked, since fence-interior lines have no delimiters. This is self-referential: L2 reviews of this very file are the most likely place to write those strings.

2. The final-line contract has tolerance only for one hardcoded Kiro footer, and none at all for codex. END { ... last == marker ... } requires the last non-empty line to equal REVIEW_COMPLETE: <lens> exactly. Leading/trailing whitespace trimming (sub(/^[ \t]+/...)) and the footer exemption are both inside the kiro { } block, so for codex-*.md any trailing framing line (session footer, token-usage line) or an indented marker line invalidates the cell — and now hard-fails the gate rather than degrading the review. The Kiro side is equally exact: ^▸ (Credits: N • )?Time: ([0-9]+m )?Ns$ matches exactly one footer shape; an extra field or a reordering makes every Kiro cell invalid. Neither risk is detectable by the new fixtures, because FAKE_CLI synthesizes both CLIs' framing (codex output = body + marker, Kiro footer = the one accepted shape) rather than replaying captured output. I could not verify real codex exec / kiro-cli stdout framing from the base checkout — there is no recorded sample in the repo — so this should be confirmed against the installed CLIs before merge. Suggest trimming for all models and matching the marker against the last non-empty, non-cosmetic line instead of literal equality.

### MINOR

3. Markers are counted inside tool output. /^REVIEW_COMPLETE:/ { markers++ } sits outside the kiro guard and is not suppressed by in_tool, and the quote-masking applies only to status (tool detection), not to marker counting. Any echoed file content or finding line that starts with REVIEW_COMPLETE: yields markers == 2 → cell discarded → forced FAIL. Same self-referential exposure as finding 1.

4. synthesize.sh: scrubber failure clobbers the real chair exit code. wait "$scrub_out" || CHAIR_STATUS=1 overwrites a 124/137 from the chair CLI, which is exactly the value attempt_chair's new guard ([ "$CHAIR_STATUS" -ne 124 ] && [ ... -ne 137 ]) tests to avoid a pointless fast-fail retry. Track scrubber failure in a separate variable and keep the CLI status.

5. run_chair now discards a fully valid review on any nonzero CLI exit. if [ "$CHAIR_STATUS" -ne 0 ]; then : > "$OUT" makes no distinction between "no/truncated output" and "complete review + nonzero exit" (deprecation warning, non-fatal MCP/telemetry error, etc.). With one fast-fail retry per model this converts a benign exit code into a BLOCKED PR. Consider keeping the output when it passes chair_valid's structural checks and only failing closed on timeout/kill (124/137) or an empty/malformed body.

6. Unreachable severe-reason branch in synthesize.sh. Vendor collapse (DEGRADED_COUNT >= TOTAL_MODELS-1) implies ≥2 models with zero rows, hence every lens has lens_count < TOTAL_MODELS, hence missing-cells.txt is non-empty. The new if [ -s missing-cells.txt ] branch therefore always wins and the final else ("at most one vendor survived") can no longer be selected. Harmless, but the vendor-collapse diagnosis the comment promises to preserve is now dead text.

7. preflight-aws-session.py branch selection is a fragile heuristic. fields = line.split(":", 3) if ":" in line else line.split() picks the parse mode per line; any colon anywhere in a whitespace-format row (a Location value containing :, future CLI formatting) shifts fields[2] to the wrong column and raises ambient provider is not the existing Pod Identity provider. Similarly, a <not set> value splits into two tokens and shifts the column. All paths are fail-closed, but the failure aborts the whole job at a step with no if: always(), so no PR comment is posted and the author sees only a step failure. Keying on the last two whitespace-separated fields, or on aws configure list --format-stable output, would be less brittle.

8. Timing-sensitive fixture, now gating merge-verify. test_timeout_and_hardkill_discard_complete_looking_stdout sets KIRO_PANEL_TIMEOUT="0.3" for the whole panel run, so all 8 Kiro cells — each a fresh python3 interpreter doing several file reads/writes, 12 processes launched in parallel — must complete twice within 300 ms or they too go missing and assert_matrix(["kiro-opus/L2"]) fails. Combined with assertLess(time.monotonic() - start, 5) and communicate(timeout=10), this is a plausible flake source on a loaded runner. Scoping the short timeout to the cell under test (or raising it to ~1 s) would keep the assertion meaningful without the race.
