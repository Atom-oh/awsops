"""ADR-019 LLM explanation layer — Korean-language prose ONLY, never numbers. The rule engine has
already decided status/monthly_savings_usd/evidence before this module ever runs; this module's
sole job is to phrase that decision for a human, and its output is discarded (not stored) whenever
it disagrees with the finding it was asked to explain. A Bedrock outage/throttle/malformed response
degrades to `None` (rendered as "설명 생성 실패" by the web UI, per the ADR: the feature works fully
without this layer)."""
import json
import os
import re

import boto3

# A bare "global.anthropic.claude-haiku-4-5" throws ValidationException invoked from
# ap-northeast-2 — every other caller in this repo (classifier.ts, assistant.ts, signal_catalog_gen.py,
# workload.tf's CLASSIFIER_MODEL_ID/K8SGPT_NARRATION_MODEL) uses the fully-qualified dated id below.
_MODEL_ID = os.environ.get("FINOPS_EXPLAIN_MODEL_ID", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
_SYSTEM = (
    "너는 FinOps 설명 도우미다. 이미 확정된 절감 항목(제목/금액/근거)을 한국어 1~2문장으로 설명한다. "
    "새로운 숫자를 만들거나, 주어진 금액과 다른 금액을 언급하거나, 실행을 제안하지 마라. "
    "숫자는 제공된 것만 그대로 인용해라."
)
_client = None


def _get_client():
    global _client
    if _client is None:
        region = os.environ.get("BEDROCK_REGION", "ap-northeast-2")
        _client = boto3.client("bedrock-runtime", region_name=region)
    return _client


def _amounts_in(text):
    """Extract every dollar-amount-shaped number the model wrote — both '$123.45' and the spelled-
    out Korean '123.45달러' notation (a review round caught the LLM being just as free to write the
    latter, which the old $-only regex couldn't see at all), for the contradiction check below."""
    dollar_sign = re.findall(r"\$\s*([\d,]+(?:\.\d+)?)", text)
    dollar_word = re.findall(r"([\d,]+(?:\.\d+)?)\s*달러", text)
    return [float(m.replace(",", "")) for m in dollar_sign + dollar_word]


def _contradicts(text, monthly_savings_usd):
    """True iff the explanation states ANY dollar figure that doesn't match the finding's own
    amount (within 1 cent — formatting/rounding noise). Requires ALL extracted amounts to match,
    not just one of several ("$9.12, 원래는 $12였는데" contains both the right number and a wrong
    one — a prior version's `any()` check let that whole sentence through). A finding with NULL
    savings must not have the LLM inventing one; any dollar amount in that case is itself a
    contradiction. NOTE: this still cannot catch every notation (e.g. "만원", a currency-unaware
    plain number) — it is a meaningful hardening, not a complete parser."""
    amounts = _amounts_in(text)
    if not amounts:
        return False
    if monthly_savings_usd is None:
        return True
    return not all(abs(a - float(monthly_savings_usd)) < 0.01 for a in amounts)


def explain(title, category, monthly_savings_usd, evidence):
    """Returns a short Korean explanation string, or None (Bedrock failure, empty response, or a
    contradiction with the finding's own confirmed numbers — in all three cases the UI shows the
    finding with no explanation rather than blocking on this)."""
    try:
        prompt = (
            f"제목: {title}\n분류: {category}\n"
            f"월간 절감액: {'$' + format(monthly_savings_usd, '.2f') if monthly_savings_usd is not None else '산출 불가'}\n"
            f"근거: {json.dumps(evidence, ensure_ascii=False)}\n"
            "위 항목을 한국어 1~2문장으로 설명해라."
        )
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 200,
            "system": _SYSTEM,
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        }
        resp = _get_client().invoke_model(modelId=_MODEL_ID, body=json.dumps(body))
        payload = json.loads(resp["body"].read())
        text = "".join(b.get("text", "") for b in payload.get("content", [])).strip()
        if not text or _contradicts(text, monthly_savings_usd):
            return None
        return text
    except Exception as e:  # noqa: BLE001 — this layer is best-effort by ADR-019 design
        print(f"[finops] LLM explanation skipped: {e}")
        return None
