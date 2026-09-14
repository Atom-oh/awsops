# Runbook — AI PR-Review Panel: Kiro Cells

This runbook covers the Kiro half of the lens×model panel (`scripts/pr-review/run-panel.sh`,
`.github/workflows/pr-review.yml`) failing its startup check or stopping for a non-transient
reason. Every symptom is surfaced as a banner at the top of the PR review comment and as an
`::error::` line in the Actions log. All 12 cells are required (`scripts/CLAUDE.md`), so a
missing Kiro cell always forces `VERDICT: FAIL`. The steps below explain *why* and remove the
cause; none of them bypasses the gate.

The signatures below are interpreted **only in Kiro stderr**. Codex also echoes the reviewed
diff to stderr, where quoted Kiro error strings must not discard a valid review or prevent a
retry. Quoted banner text in this document mirrors `synthesize.sh` output.

## 1. Symptom A — `🚫 Kiro monthly request quota exhausted`

Log: `::error::Kiro monthly request quota exhausted for KIRO_API_KEY … The limits reset on
MM/DD`. Two shapes exist:

- **At preflight** (the usual one): the first model's startup check hits the limit. No Kiro
  review starts at all; every Kiro cell logs `[skip] kiro-<model>/L<n> (monthly quota exhausted
  at preflight)`, the preflight banner (Symptom C) appears together with this one, and only
  `codex/L2..L5` respond.
- **Mid-run**: the limit is reached while review cells are running. Only the cells that hit it
  log `[quota] kiro-<model>-L<n> — monthly request limit reached, not retrying`; earlier Kiro
  cells may have completed normally.

Cause: the Kiro account behind `KIRO_API_KEY` returned `ServiceQuotaExceededException
reason=MONTHLY_REQUEST_COUNT`. The v2 engine reports it as stderr `Monthly request limit
reached` with rc=0 and empty stdout, which looks like an empty response without signature
detection (`KIRO_QUOTA_RE` in `run-panel.sh`; the v3 shape `MONTHLY_REQUEST_COUNT` /
`UsageLimitReachedError` is matched too). The key lives in Secrets Manager
`/demo-platform/actions/AI-key` (AWS-Demo-Platform repository, ExternalSecret `ai-panel-keys`)
and is **shared by every repository** whose PR review runs on the `actions-runner-claude`
image, so one busy month anywhere exhausts it for all. It is not a headless-flag problem and
cannot be fixed in this repository's code.

Action (account side only):

1. Enable overages on the owning Kiro account, **or** issue a key from an account with
   remaining quota and update `KIRO_API_KEY` in `/demo-platform/actions/AI-key`. ESO refreshes
   the runner secret; new runner pods pick it up.
2. Re-run the failed `AI Code Review` workflow (or push to the PR). The banner disappears when
   the Kiro cells respond again.
3. If nothing is done, the quota resets on the date printed in the banner.

Verification without spending CI minutes — run it on a runner pod or another host that already
holds the key in its environment. Do not copy the shared key to a laptop; if you must fetch it,
keep it out of argv (`env VAR=…` and `export` on the command line expose it in
`/proc/<pid>/cmdline` and shell history) and rotate it afterwards:

```bash
# Working directory: any empty scratch directory (no repo, no .kiro/).
d=$(mktemp -d)
( cd "$d" && HOME="$d" KIRO_API_KEY="$(aws secretsmanager get-secret-value \
      --secret-id /demo-platform/actions/AI-key --region ap-northeast-2 \
      --query SecretString --output text | jq -r .KIRO_API_KEY)" \
  kiro-cli chat "Reply PONG." --model gpt-5.6-terra --no-interactive --wrap never )
# exhausted → stderr "Monthly request limit reached", empty stdout, exit 0
```

The prefix assignment is consumed by the shell and is not part of the process command line.
Never echo the key or paste it into an issue or PR.

## 2. Symptom B — `🔓 Kiro agent contract broken`

Log: `::error::kiro-cli ignored --agent pr-review-readonly (fell back to the default agent) …`
(mid-run) or `::error::kiro-cli ignored --agent pr-review-readonly during preflight (…)`. The
affected cell responses are discarded even when they are non-empty; at preflight no Kiro review
starts (`[skip] … (agent fallback at preflight)`).

Cause: kiro-cli printed `Error: no agent with name pr-review-readonly found. Falling back to
user specified default` — a missing agent file, invalid JSON (`Json supplied at
…/pr-review-readonly.json is invalid`) or an agent schema the runner's kiro-cli version rejects
all produce it — and continued with the default agent at rc=0. The default agent trusts
read/glob/grep/code inside the cwd plus read-only `aws` calls, which is wider than this
repository's read+grep contract (Section 4). The diff is untrusted input, so this is treated as
a broken contract and forces FAIL (`KIRO_AGENT_FALLBACK_RE`, anchored on the agent name).

Action:

1. Compare the kiro-cli version printed on the first line of the panel step
   (`run-panel.sh: kiro-cli X.Y.Z`) with the version the agent file was validated with (2.11.1).
2. Validate the file with that version. Note that 2.11.1's `validate` prints errors such as
   duplicate keys to stderr yet returns rc=0, so read the output:
   `kiro-cli agent validate --path scripts/pr-review/agents/pr-review-readonly.json`
   (working directory: repository root).
3. Re-verify the read-only behaviour before changing anything else:
   ```bash
   # Working directory: a scratch directory; the repo copy of the agent is installed into it.
   d=$(mktemp -d); mkdir -p "$d/.kiro/agents"
   cp scripts/pr-review/agents/pr-review-readonly.json "$d/.kiro/agents/"
   echo CANARY > "$d/notes.txt"
   ( cd "$d" && kiro-cli chat "Read ./notes.txt and print it, then run 'id' with a shell tool. If a tool is unavailable say NO_TOOL_<name>." \
       --agent pr-review-readonly --model gpt-5.6-terra --no-interactive --wrap never )
   # expected: CANARY printed via "using tool: read"; NO_TOOL_shell (no shell/aws/write tool use)
   ```
4. Do **not** switch to `--v3` / `--agent-engine v3` to work around it: the v3 engine ignores
   the agent's `tools` list.

## 3. Symptom C — `🛑 Kiro preflight failed`

The `kiro-preflight.flag` banner means the fixed startup check (Section 5) did not confirm the
contract; no PR input was sent to Kiro. Inspect the preflight stderr in the Actions log
(`::error::Kiro preflight failed for <model> (exit N)` followed by the scrubbed stderr tail):
quota and agent fallback also raise their own banners (A/B); timeouts, authentication errors
and a reply that is not exactly `PONG` fail the check too. Resolve the reported cause, then
rerun CI. Do not bypass the preflight.

Malformed agent JSON (including duplicate keys), tools other than read/grep, MCP/resources/hooks
settings, keys outside the allowlist, or a failed agent copy abort the panel step with rc=1
before any model is called — visible in the failed step log as `invalid read-only agent
configuration` / `failed to install kiro agent`.

The runner image and CLI version are managed in the AWS-Demo-Platform repository's
`docker/actions-runner-claude/Dockerfile` (unpinned vendor-latest); pinning or rebuilding that
image is a separate change from this repository's review scripts.

## 4. Reference — this repository's Kiro tool contract

Unlike the sibling repositories (aws-fsi-demo, ttobak, claude-code-usage-dashboard) the Kiro
cells here are **not zero-tool**. The diff is delivered as a file path (headless `kiro-cli chat`
ignores stdin and argv embedding hits the kernel MAX_ARG_STRLEN cap) and the lens prompts' BASE
CONTEXT rule requires reading the base checkout to filter false "missing" findings. The contract
is therefore **read + grep only**, pinned in `scripts/pr-review/agents/pr-review-readonly.json`
(`tools` = `allowedTools` = `["read","grep"]`, no MCP/resources/hooks) and passed via
`--agent pr-review-readonly`. At run time the file is copied into the cell cwd's `.kiro/agents/`
(the base checkout) and removed by an EXIT trap, so it is gone after normal completion, the
nonce-failure exit and a cancelled run alike (the path is also listed in `.gitignore`).

`--trust-tools=read,grep,fs_read` is no longer used: kiro-cli 2.11.1 parses unknown names (the
empty string, the stale `fs_read`) as custom tools, prints `WARNING: --trust-tools arg for custom
tool  needs to be prepended with @{MCPSERVERNAME}/` and ignores them, while the default agent's
trust (read/glob/grep/code inside the cwd, read-only aws) stays active. `--v3` /
`--agent-engine v3` ignores the agent's `tools` list, so the panel stays on the default v2
engine (and does not use the v3-only `--mode default`).

## 5. Reference — startup verification (preflight)

Before any Kiro review starts, each model (`claude-opus-5`, `gpt-5.6-terra`) receives one fixed
prompt without the diff ("Reply with exactly PONG …") using the same agent. Passing requires
exit 0, no fallback/quota signature in stderr, and a reply that is exactly `PONG` once transport
decoration (ANSI, the `> ` assistant prefix, blank lines, the numeric usage footer) is stripped.
Both models must pass before either receives PR input. This adds at most two model calls per
run, each bounded by `KIRO_PREFLIGHT_TIMEOUT` (default 120s). On failure all 8 Kiro cells are
skipped with the reason in the `[skip]` line, the 4 Codex cells keep running, and
`kiro-preflight.flag` + `coverage-severe.flag` are written (the all-12-cells rule would force FAIL
anyway). Post-execution fallback detection (Symptom B) remains an additional safeguard.

## Related

- Scripts: `scripts/pr-review/run-panel.sh`, `scripts/pr-review/synthesize.sh`,
  `scripts/pr-review/agents/pr-review-readonly.json`, `scripts/CLAUDE.md`
- Tests: `tests/structure/test-pr-review-panel.sh`, `tests/structure/test-pr-review-panel-prompt.sh`,
  `scripts/pr-review/test_review_completion.py`
- Workflow: `.github/workflows/pr-review.yml`
- Origin of the fix: claude-code-usage-dashboard PR #33 (sibling ports: aws-fsi-demo #509,
  ttobak #193); the v2-engine decision matches the AWS-Demo-Platform repository's ADR-011
  (unrelated to this repository's own ADR-011).
- ADR-005 (`docs/decisions/005-aws-mutation-autonomy-frozen.md`): the read-only contract of every
  automated AWS-touching path in this repository, which the agent's tool grant (no `aws` tool)
  also respects.
