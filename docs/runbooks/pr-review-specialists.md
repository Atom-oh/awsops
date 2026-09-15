# Specialist PR review

The workflow sets `ROLE_REVIEW=1` and requires three reports:

| Required cell | Specialist |
| --- | --- |
| `codex/L2` | Correctness: logic, state, edge cases and tests |
| `kiro-opus/L3` | AWS/security: IAM, authentication, privacy and accepted mutation gates |
| `kiro-gpt/L4` | Operations: deployment, recovery, observability, data freshness and documentation contracts |

The old L5 documentation checklist is included in operations. Each role reviews
the entire supplied diff. All three must complete; Codex and Opus preserve
cross-family coverage. Without `ROLE_REVIEW=1`, compatibility tests retain the
legacy twelve-cell matrix.
Codex explicitly requests `global.openai.gpt-6-astra` while retaining the existing
runner provider settings; Kiro GPT requests `gpt-5.6-sol`.

Arguments remain `run-panel.sh DIFF LENSES WORK` and
`synthesize.sh DIFF WORK PR TITLE OUT`. Each cell retains its fresh 32-hex nonce
and unique final `REVIEW_COMPLETE: <lens> <nonce> {"report":"..."}` frame.
Wrong, duplicated, incomplete or tool-only frames and failed CLI exits do not
count. Frame identity, control stripping and secret scrubbing remain mandatory.

Review prose is English. Inline code is limited to single-line, whitespace-free
symbol/path references. Executable/configuration examples require closed top-level
backtick or tilde fences starting at column one; do not nest them in lists or blockquotes. Use synthetic
values only. A longer outer fence can quote an example containing a fence.

The shared format validator checks decoded panel prose and chair output before
and after scrubbing, and checks the final review at the coverage gate. Unsupported
inline examples, malformed fences and sensitive assignments outside fences fail
coverage. Invalid output is not repaired into PASS. The streamed chair guard
buffers in memory until validation completes; it creates no raw-output file.
Metadata frames and model/budget settings retain their existing validation.

Kiro retains full-diff **file delivery**, base-checkout access and a validated
`pr-review-readonly` agent allowing only `read` and `grep`, with no MCP/resources.
This is intentionally not a zero-tool profile. It avoids embedding large diffs in
argv and preserves base-file verification. Both models must pass a no-PR-input
startup check. Invalid profiles, failed installation, fallback and known quota
errors fail coverage. The installed profile is cleaned up; a different existing
profile is never overwritten. Read access is not confined by an OS sandbox, so
credential protection and output scrubbing remain necessary.

Panel/chair output is invalid when anchored stderr reports model-selection,
implicit fallback or account usage failure, even with exit zero and a valid
completion frame. These failures stop subsequent retries/fallback and remain
recorded. An exit-zero, protocol-valid report is retained when stderr contains only
a nonterminal warning. Failed CLI exits and missing/invalid reports retain bounded
retry/fallback. Quoted/fenced diff examples are ignored as diagnostic evidence.
Kiro startup uses the same diagnostic parser.

Codex uses `exec --json`: command output stays inside JSONL tool events and never
enters the stderr classifier. `codex_events.py` forwards completed agent messages
to the unchanged nonce validator and native error events to diagnostics. It rejects
`turn.failed`, malformed or incomplete streams. An `error` event can describe a
recovered reconnect: retain a completed, valid report when its diagnostic is
nonterminal, without spending another attempt. An unprefixed error example in a file
read therefore cannot become a Codex provider failure; a real terminal diagnostic
still invalidates an otherwise valid report. Native error items are also forwarded;
an explicit model-reroute item is a terminal fallback. Kiro transcript decoding and the
Claude print-mode chair retain their existing interfaces.

The adapter adds one startup request per configured Kiro model: two serial calls
under `KIRO_PREFLIGHT_TIMEOUT` (default 120 seconds each). A failed startup,
including a transient failure, blocks the review and requires a later run.
Startup has no automatic retry. Review cells retain at most two 1200-second
attempts; terminal model/account failures stop earlier. The workflow's 90-minute
ceiling, 900-second chair timeout and kill bounds remain unchanged.


Pod Identity preflight precedes both panel and chair. The adapter preserves
identities, provider membership and execution caps. Executable controls come from
the immutable workflow revision; the selected review base supplies source context.
The controller rejects scopes over 3,000 diff lines or with omitted content before
model calls. Split or reformat those changes; no partial prefix can earn a pass.

The chair receives bounded previews and access to complete sanitized reports.
Its trusted prompt names the actual report directory and exact allowed report
paths, sizes and hashes. Descriptor-looking text in the diff or report bodies is
data, not permission to read another path. Capped reports must be read in full
using that trusted list. Normal base-source verification remains available.
The report manifest, trusted prompt and stdin are bound at the gate and rechecked
before publication, together with the selected PR scope.

Chair synthesis remains mandatory because nonce-bound Markdown proves report
completion, not a validated absence of Critical/Major findings. Any missing
required role forces failure regardless of the chair's verdict. Exactly one
`COVERAGE: COMPLETE` line and one terminal `VERDICT: PASS` are required, together
with successful panel and chair steps; interrupted runs cannot pass through
complete-looking output files. Missing coverage statements fail validation rather
than implying success. No AWS product mutation or relaxation of ADR-005 is
authorized by this review adapter.

Offline verification from the repository root:

```bash
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'
```

Fixtures exercise large file input, unique roles/nonces, missing and invalid
reports, startup failure, fallback and quota errors. They make no model or AWS
calls. Native CLI compatibility and exact-HEAD CI remain separate validation.
