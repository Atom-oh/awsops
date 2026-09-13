# AI routing and response verification

The retired `scripts/test-ai-routes.py` and `/awsops/api/ai` are not v2 test entrypoints.
Use the checked-in routing fixtures and current chat/agent tests instead of a manual
list of old gateway/tool counts.

## Offline checks

From the repository root:

```bash
(cd web && npx vitest run lib/route.test.ts lib/merge-invariants.test.ts)
(cd agent && python3 -m pytest test_agent.py -q)
python3 -B -m unittest discover -s scripts/v2 -p test_evaluate_diagnosis.py -v
```

Confirm the exact test paths exist in the current checkout before narrowing a run.
Use `bash scripts/v2/merge-verify.sh` for the isolated Python and web suites.
The standalone diagnosis evaluator tests a reference prompt/harness; it is not
production agent accuracy. See [diagnosis evaluation](diagnosis-evaluation.md).

## Live verification

`node scripts/v2/routing-accuracy.mjs` calls real Bedrock for the ADR-003 golden-set
rollout check. Record the fixture revision, model/configuration, scope and results.
Do not present offline tests or illustrative questions as measured accuracy, latency,
cost savings or a completed live model run.

Use authenticated `/api/chat` or the product assistant to inspect routing, streamed
progress, source evidence and final output. Check the code's current first-match
routing order and gateway catalog. `observability` resolves to `external-obs` with
canonical/`v2-` key compatibility. Registered `aws-data`/collector keys intentionally
fall back: no live Steampipe SQL or collector execution should occur in those paths.

A successful HTTP response is not enough: distinguish unavailable tools, denied
access, stale/partial data, unsupported sources and a supported empty observation.
Keep raw tool tags and credentials out of user-visible responses. Verify each
supported UI language separately; English developer docs do not remove Korean
routing fixtures or product translations.
