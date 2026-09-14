# Diagnosis evaluation

The standalone evaluator uses synthetic cases for queue delay, worker crash,
database authentication, dependency timeout, insufficient/conflicting evidence and
prompt injection in evidence. It evaluates a reference prompt, not a replay of the
production AgentCore/collector/worker pipeline. Model accuracy and realized savings
remain unmeasured until actual predictions and appropriate measurements are supplied.

## Production integration boundary

This CLI evaluates the standalone reference prompt, not the deployed
`report.generate` → collectors → deterministic invariants → report pipeline.
The production service-map collector emits X-Ray `to_ref` without a resolved `to`;
the inventory collector emits no `unencrypted` aggregate. Those fields are required
by `diagnosis/invariants.py`, so all six live invariant kinds currently remain
`unknown`. Normalized unit fixtures can exercise valid zero and observed violations,
but do not establish that the live collectors provide those inputs. Empty regression
or improvement lists under this limitation do not certify a healthy configuration.
The producer adapters and real collector-to-verdict validation remain pending.

Generated reports record `summary.invariant_coverage` (total, assessed, passed, failed,
unassessed) and `summary.unassessed` verdicts. Intended vs Actual renders those results
without an LLM, so missing evidence remains visible in the Markdown and its exports.
The UI displays the same counts/reasons and labels legacy reports without valid coverage
as assessment unavailable. No active invariants is distinct from an evaluated pass.



## Offline use

Run from the repository root. Offline scoring uses Python's standard library and
reads no AWS credentials or network data.

```bash
python3 -B -m unittest discover -s scripts/v2 -p test_evaluate_diagnosis.py -v
python3 -B -S scripts/v2/evaluate_diagnosis.py \
  --fixtures scripts/v2/fixtures/diagnosis-eval.json \
  --predictions /tmp/diagnosis-predictions.jsonl > /tmp/diagnosis-evaluation.json
```

Provide the prediction file yourself. Exit 0 means valid and complete **regardless
of score**, 1 means valid but incomplete, and 2 means invalid input/usage or runner
failure. There is no production acceptance threshold or CI score gate.

## Input and scoring contract

Predictions accept an array, a single JSON object or JSONL. This is a format example,
not a model result; submitting one case does not complete the fixture set:

```json
{"case_id":"queue-delay","ranked_cause_ids":["queue_delay"],"cited_evidence_ids":["queue-ledger","queue-dispatch"],"abstained":false,"confidence":0.9,"elapsed_ms":125,"cost_usd":null}
```

Required fields: case ID, one to three distinct ranked cause IDs (empty only when
abstaining), case-local evidence IDs, boolean abstention, confidence in [0,1], and
elapsed milliseconds in [0,86400000]. Optional cost is in [0,1000000]; omitted/null
means unknown, while explicit zero is a measured/supplied zero. Confidence is not
scored for abstentions. Duplicate/unknown IDs or keys, extra fields, invalid types,
NaN/Infinity and inconsistent abstention/ranking are rejected. Fixture schema v1
requires synthetic declarations, globally unique evidence IDs and expected cause
or abstention with supporting evidence; every case is required.

| Metric | Interpretation |
| --- | --- |
| Coverage | Supplied cases/all cases, with missing IDs; conclusion coverage excludes abstentions from its numerator |
| Top-1/Top-3 | Correct cause at rank 1/within first 3, divided by all answerable cases including missing predictions |
| Decision accuracy | Correct top-1 or correctly required abstention/all cases; missing predictions earn no credit |
| Citation validity | Structural case-local ID validity, not semantic grounding |
| Support precision/recall | Gold citations/all citations; cited gold/all required gold including missing cases |
| Grounded decision | Correct conclusion with all gold evidence and no distractors/all cases |
| False confident conclusions | Wrong or ungrounded non-abstention with confidence >=0.8; denominator is submitted confident conclusions |
| Abstention | Required/observed/correct/unnecessary counts; missing cases remain in recall's denominator |
| Latency | Submitted durations only; nearest-rank percentiles, no invented zero samples |
| Cost | Known/unknown counts and known sum/mean; total only if every case has known cost |

Undefined denominators yield null. Identical inputs produce deterministic scores;
prediction ordering does not matter. ID matching does not evaluate free-text
entailment, confidence calibration, unseen incidents or production reliability.

## Optional model execution

Only explicit `--run-model` invokes Bedrock Converse. Use an approved model/profile
supporting system prompts and the configured inference settings; there is no default
model or fallback. This is billable and requires boto3/botocore and model access.

```bash
python3 -B scripts/v2/evaluate_diagnosis.py --run-model \
  --model-id "$DIAGNOSIS_MODEL_ID" --region "$DIAGNOSIS_REGION" \
  --fixtures scripts/v2/fixtures/diagnosis-eval.json \
  --predictions-out /tmp/diagnosis-reference-predictions.jsonl \
  > /tmp/diagnosis-reference-evaluation.json
```

The output path must be new. Only case IDs, summaries, candidates and evidence are
sent; gold labels are withheld. `REFERENCE_PROMPT` (`sre-evidence-only-v1`) requires
case evidence, ignores embedded instructions and abstains for insufficient/conflicting
evidence. Read the exact prompt in `scripts/v2/evaluate_diagnosis.py` rather than a
second copied prompt. Measured duration is Converse latency, not production job
latency. Tokens are not converted into dollars. On failure, exit 2 retains only
validated earlier predictions; score that partial file offline to expose coverage.
Malformed output is not converted into a fabricated abstention.

## Bounds and evidence hygiene

Input files are capped at 1 MiB; offline limits are 32 cases, 16 candidates and 16
evidence records/case, ID length 64, candidate description 200, summary 1,000 and
evidence text 2,000 characters. Model mode uses at most 8 sequential calls, a reused
client, 5-second connect/30-second read timeouts and one attempt with no retries.
System/case text is capped at 16,000 UTF-8 bytes, output at 512 tokens and response
at 8,192 bytes. Only one normally terminated JSON text block is accepted; truncation,
tool use or malformed content fails closed. SDK timeouts do not guarantee a whole-run
time or dollar budget.

Keep fixtures synthetic and remove credentials/personal data before an explicit
model run. A synthetic flag is a declaration, not a redaction scanner. Retain fixture
revision, predictions, model/region and prompt version for comparisons. Harness
success is not a measured diagnosis accuracy or production-readiness claim.
