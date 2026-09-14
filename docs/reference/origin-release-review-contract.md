# Origin release source and preparation helpers

These helpers do not deploy workloads or grant IAM permissions. A consumer must
run `python3 scripts/v2/ci_origin_guard.py` **before assuming release credentials**
and stop on any nonzero exit.

The guard uses `gh api` with the workflow's GitHub credentials. It requires
`GITHUB_REPOSITORY=Atom-oh/awsops`, `GITHUB_REF=refs/heads/main`,
`GITHUB_EVENT_NAME=workflow_dispatch`, `GITHUB_SERVER_URL=https://github.com` and
the full `GITHUB_SHA`. It verifies that SHA is still main, finds its merged origin
PR, and requires exactly two merge parents, the reviewed PR HEAD as the second
parent, and identical merge/HEAD Git trees. Squash/rebase merges or a merge tree
changed by conflict resolution cannot inherit the HEAD's review.

It requires complete configured specialist coverage, a trusted bot's passing
review bound to that HEAD, and successful genuine workflow checks. The AI check
must originate from `.github/workflows/pr-review.yml` with `pull_request_target`;
a post-merge `workflow_dispatch` review alone does not satisfy this contract.
Main is checked again before returning the JSON proof (`commit_sha`,
`reviewed_head`, `pr_number`, `ai_comment_id`, `verified_at`).

## Blocking feedback

Submitted review bodies and unresolved inline thread comments use the same
severity detector. It checks every visible line, including headings, ordered and
unordered nested lists, and list continuation text. It recognizes leading
`Critical`, `Major`, `P0`, `P1`, numbered `Finding` labels and `Severity:` labels
with Markdown emphasis. Context paragraphs and earlier Minor findings do not
hide later blockers. For example:

```markdown
- Findings
    - Finding 1 (Minor): wording
    - **Severity**: Major — rollback is broken
```

Minor/Info and severity words inside ordinary explanatory prose do not block.
Fenced code, indented code (four spaces relative to its enclosing list content),
and explicitly quoted lines are excluded, including inside lists. Indentation
alone cannot start a code block in the middle of a paragraph: for example,
`Context.` followed immediately by an indented `**Severity:** Major` is visible
paragraph text and blocks. Blank lines or block boundaries end that paragraph.
This is a bounded Markdown severity convention, not natural-language issue resolution;
write actual findings with these labels and examples in code fences or quotes.

Reviews are processed in review-ID order per author. `CHANGES_REQUESTED` blocks
regardless of body. A later nonblocking `COMMENTED` review does not clear either
a change request or a body finding. A later `APPROVED` or `DISMISSED` review by the
same author clears earlier blockers; another author's approval does not. New
findings after approval (including in that approval's own body) block again.
Pending drafts and dismissed bodies are ignored. Inline threads clear only when
`isResolved` is true; `isOutdated` alone is never resolution evidence.

## Private preparation

`python3 scripts/v2/ci_origin_workflow.py` exposes `prepare`, `verify-caller`,
`fetch-smoke-secret` and `cleanup`. Its nonsecret inputs are
`CI_EXPECTED_ACCOUNT_ID`, `CI_EXPECTED_PROJECT`, `AWS_REGION`, `CI_EXPECTED_URL`,
`CI_ROLE_ARN` (the project's `ci-release` role), `CI_SMOKE_SECRET_ARN` (the
project's deployment-verifier secret), `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`.
`CI_SQL_READER_SECRET_ARN` is declaration-only: provide the project SQL-reader
ARN or literal `disabled`; the helper neither fetches it nor grants access.

`prepare` uses `RUNNER_TEMP` and `GITHUB_ENV` to declare run-owned private paths.
After the consumer assumes the approved role, `verify-caller` checks the actual
STS caller. `fetch-smoke-secret` writes `{email,password}` only to the prepared
`CI_SMOKE_CREDENTIAL_FILE`. Consumers must enforce guard/assume/verify/fetch order;
the preparation helper does not itself consume the source proof. `cleanup`
removes only its run-owned directory. Credentials are never GitHub outputs or
shell arguments. Neither helper reads Terraform state.

Run the offline regressions from the repository root:

```bash
python3 -B -m unittest discover -s scripts/v2 -p test_ci_origin_guard.py -v
python3 -B -m unittest discover -s scripts/v2 -p test_ci_origin_workflow.py -v
```
