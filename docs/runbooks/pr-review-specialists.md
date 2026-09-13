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
count. Decoding, control stripping and secret scrubbing remain unchanged.

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
recorded. Service throttles keep the existing bounded recovery; quoted/fenced diff
examples are ignored as diagnostic evidence. Kiro startup uses the same parser.

The existing Pod Identity preflight still precedes both panel and chair. The
adapter does not change identities, L1/source-omission gates, model roster,
1200-second panel timeouts, retry/kill bounds, chair caps or publication checks.
The existing workflow's 3000-line prefix limit remains a coverage limitation:
the adapter gives every role the same supplied prefix; it does not implement
complete-diff chunking or claim to review omitted bytes.

Chair synthesis remains mandatory because nonce-bound Markdown proves report
completion, not a validated absence of Critical/Major findings. Any missing
required role forces failure regardless of the chair's verdict. No AWS product
mutation or relaxation of ADR-005 is authorized by this review adapter.

Offline verification:

```bash
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'
```

Fixtures exercise large file input, unique roles/nonces, missing and invalid
reports, startup failure, fallback and quota errors. They make no model or AWS
calls. Native CLI compatibility and exact-HEAD CI remain separate validation.
