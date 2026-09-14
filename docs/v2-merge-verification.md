# Merge verification

## Scenarios

| Scenario | Invariant | Design source | Verification code path | Command |
| --- | --- | --- | --- | --- |
| S1 | Frozen and gated Terraform resources stay default-off, gated by `count` or `for_each`, and tracked tfvars do not enable gated flags. | `docs/decisions/BASELINE.md`, ADR-005, ADR-006, ADR-007 | `scripts/v2/test_merge_invariants.py`, `scripts/v2/merge_invariants.py` | `python3 -m pytest scripts/v2/test_merge_invariants.py -q` |
| S2 | Gateway-routed sections align across AgentCore catalog, web sections, route rules, and the `observability` to `external-obs` alias; v1 `/awsops/` route literals do not leak into v2 web sources. | ADR-004, ADR-003 | `web/lib/merge-invariants.test.ts`, `web/lib/merge-invariants.ts` | `cd web && npx vitest run lib/merge-invariants.test.ts` |
| S3 | The local runner executes isolated Python/web tests and advisory Terraform checks; CI additionally requires pinned, backend-free runtime IAM mock plans. | Current merge runner and workflow | `scripts/v2/merge-verify.sh`, `.github/workflows/merge-verify.yml` | `bash scripts/v2/merge-verify.sh` |
| S4 | Every configured model/lens cell requires a successful CLI exit and nonce-bound final report frames; only decoded, scrubbed reports reach the chair. | PR-review execution protocol | `scripts/pr-review/test_report_frame.py`, `scripts/pr-review/test_review_completion.py`, `scripts/pr-review/test_aws_preflight.py` | `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v` |
| S5 | Publication requires unchanged review scope, complete input and all configured reports; bounded previews cannot hide the full sanitized reports from the chair. | Trusted scope and report binding | `scripts/pr-review/review_scope.py`, `scripts/pr-review/test_review_scope.py`, `tests/structure/test-pr-review-chair-input-caps.sh` | The offline review command above and `bash tests/structure/test-pr-review-chair-input-caps.sh` |

## Structural gate limitation

`ungated_resources()` searches the whole Terraform resource body for `count` or
`for_each`. A `for_each` inside a nested `dynamic` block can satisfy this heuristic
without gating the resource itself. S1 therefore does not prove top-level gating;
review the actual resource arguments and saved plan. The scanner has not been
changed by this documentation update.

## Runner Usage

Run the full merge verification from the repository root:

```bash
bash scripts/v2/merge-verify.sh
```

The runner discovers `test_*.py` under `scripts/v2` and `agent` by default, then runs each file in a
separate `python3 -m pytest` process from the file's own directory. Files in a `tests/` directory get
that directory's parent prepended to `PYTHONPATH` for that one pytest process, so adjacent module-root
imports such as `agent/anthropic_loop.py` resolve while failure summaries still use the original
discovered path. Override the Python search root for focused checks:

```bash
MERGE_VERIFY_PY_ROOT=/tmp/merge-fixtures MERGE_VERIFY_SKIP_WEB=1 bash scripts/v2/merge-verify.sh
```

Set `MERGE_VERIFY_SKIP_WEB=1` only for local fixture or runner development. The CI workflow runs the
web vitest stage.

The Terraform stage runs `terraform -chdir=terraform/v2/foundation fmt -check` when the binary is
available, and also runs `validate` when `terraform/v2/foundation/.terraform` exists. Missing
Terraform tooling is reported as `SKIP`; Terraform diagnostics are non-blocking in this runner.
CI separately pins Terraform 1.15.7 and requires backend-free init, validate and
`terraform test -filter=tests/runtime_iam.tftest.hcl -filter=tests/github_actions_release.tftest.hcl -filter=tests/github_actions_migration.tftest.hcl`. Providers are mocked, credentials are
not supplied, and the lock records Linux amd64/arm64 checksums. These required checks cannot
be skipped by the local advisory stage.

Required Node checks also cover the migration TLS/context and private image
entrypoint suites. They verify local certificate handshakes and receipt behavior
without AWS credentials.

## Pytest Isolation

Do not replace the Python stage with a single aggregate `pytest scripts/v2 agent` command. The current
suite has known false positives when files share one Python process: tests mutate `sys.path` and
environment variables, and same-name helper modules such as `db` and `handlers` can collide. Running
each `test_*.py` file in its own pytest process preserves isolation and avoids cross-file state collisions.

## CI Gate

The `merge-verify` job in `.github/workflows/merge-verify.yml` runs on pull requests targeting `main`
and manual dispatch. It checks out the selected revision,
sets up Node.js 20, Python 3.12 and Terraform 1.15.7, installs web dependencies with `cd web && npm ci`, installs
`pytest` plus the v2 Python subsystem requirements, and executes `bash scripts/v2/merge-verify.sh`.
It also runs the offline PR-review regressions and selected structure checks in a separate step:

```bash
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v
bash tests/structure/test-pr-review-chair-input-caps.sh
bash tests/structure/test-pr-review-large-diff.sh
```

For the local full suite (hooks, structure, offline PR review, and agent tests), run:

```bash
bash tests/run-all.sh
```

This full-suite command is not a step in `merge-verify.yml`.
The workflow also has a separate `deck-verify` job: it installs `docs-site` dependencies
and runs `docs-site/scripts/verify-deck.sh` against the committed presentation. This does not
run a docs-site build or the full local hook/structure suite; the two selected
structure checks above run explicitly in `merge-verify`.

These fixtures cover every required model/lens report, strict final JSON frames and nonces,
quoted/plain/fenced tool strings and static marker examples, numeric Kiro footers,
discarded nonzero/timed-out output, chair CLI exit status, retries, hard kills and decoded
session-token redaction. Captured L2/L4 bodies are historical roundtrip fixtures; they do
not approve the current parser or establish completion of the old runs. The fake matrix
checks that decoded reports reach the chair without tool chatter. Full sanitized reports
remain in a private directory with read-only files and a manifest of paths, sizes and hashes.
The chair receives bounded previews and must read each capped report in full. The gate
binds the manifest, trusted prompt and chair input, then rechecks them before publication.
The trusted prompt names the actual report directory and exact authorized report records;
descriptor-like text in the patch or report bodies cannot extend that list. Neither retained
bytes nor a hash proves semantic completeness: exactly one `COVERAGE: COMPLETE` line and
one terminal `VERDICT: PASS` are also required. Missing, changed, duplicated or symlinked
report records fail closed. Fixtures cover both configured specialists and legacy matrix mode.
Cell scrubber failure is tested behaviorally. Chair scrubber PID capture/waits remain
structural checks, without an injected chair-scrubber failure fixture.
No fixture calls live AWS or AI services or dumps the full environment.

Each cell receives a fresh, CI-generated 32-hex nonce stored alongside its slot. Its final
output must be one physical line:

```text
REVIEW_COMPLETE: L2 <32-lowercase-hex-cell-nonce> {"report":"No findings.\nReviewed this lens."}
```

Only a strict JSON object with one nonblank string field, `report`, is accepted. Frame
counting is bound to this cell's expected nonce. Earlier other-nonce source examples are
opaque chatter and are never decoded or credited. A wrong-nonce-only transcript has no
matching frame; an other-nonce frame after the current one makes it nonfinal. Duplicate
expected-nonce frames, same-nonce wrong lenses, duplicate keys, invisible/control-only
bodies, malformed current frames and trailing output fail closed. Kiro's optional assistant prefix and one numeric usage/time
footer are transport decoration. No tool-header, fence, or static-marker heuristic establishes
completion, and there is no legacy-marker fallback.

`try_panel` checks the original frame only after CLI exit zero. `record_result` validates it
again, decodes the report, strips decoded controls and scrubs secrets before logging or
replacing the slot. Rejected previews hide encoded frame payloads and keep other diagnostics
bounded and scrubbed. Existing chair input caps still apply. The nonce is a nonsecret run
binding, not an authorization credential or a replacement for AWS signing.

The AI-review workflow has a 90-minute ceiling and runs `preflight-aws-session.py` before
both panel and chair. Using the existing AWS CLI, preflight requires the ambient
`container-role` provider and a successful signed `sts get-caller-identity` call, so
invalid/expired credentials fail closed. It preserves EKS Pod Identity, profiles and signing
settings. Subsequent model CLIs retain their SDK refresh path.

## Checks outside CI

For routing rollout verification, run the ADR-003 golden-set check against real Bedrock:

```bash
node scripts/v2/routing-accuracy.mjs
```

ADR-003 records at least 85% accuracy and a 15 percentage-point improvement over regex
as rollout criteria. A documentation-only change does not alter routing; do not report
a live model check as executed unless it was actually run.

Run the production web build for application/release changes:

```bash
cd web && npm run build
```

## Reviewer context

The AI workflow first preserves its complete control bundle from the immutable
workflow revision, then selects and checks out an authenticated review base. An open
PR uses the current target ref and its merge-base with the exact event HEAD. Manual
replay accepts only a same-repository merged PR with two verified parents and a merge
tree equal to its HEAD tree; squash and other unmatched merge shapes are refused.
Controls stay outside the selected checkout so an older base cannot remove required
helpers or substitute its own review engine. PR head is never checked out or executed.

Before publication the controller rechecks the PR identity, selected base, diff bytes,
configured roles and full report evidence. A changed scope cannot publish a passing
result. Both review-phase steps must have succeeded; complete-looking files left by
an interrupted or failed phase cannot establish a passing review. Failure reporting
does not overwrite a newer HEAD's canonical review.
Reviewers must account for the patch when checking symbols and policy; the
base alone is not the resulting implementation. Root `AGENTS.md` and
`docs/decisions/BASELINE.md` provide current rules. Consolidated ADR filenames are
`NNN-*.md`, not `ADR-*.md`; legacy references need ADR-MAPPING.md. Historical plans
and old test labels cannot grant feature enablement or establish a new violation.

Developer docs are English-only; multilingual product guides remain. Review
concrete broken contracts/commands and operational impact, not invented README
sections, bilingual parity or hand-maintained counts.

The review controller allows at most 3,000 diff lines. Oversized scopes and omitted
content are rejected before model calls, with instructions to split or reformat the
change. There is no partial-review override or absence-claim downgrade that permits
a pass. Keep PRs within the complete review scope.
All required cells and the chair must finish successfully at the latest HEAD.
Changing documentation does not authorize disabling coverage or severity gates.

The generic S1 scan collects `*_enabled` defaults; `inventory_host_only` is instead
checked explicitly by the runtime IAM mock fixture. Neither scanner proves live access.
