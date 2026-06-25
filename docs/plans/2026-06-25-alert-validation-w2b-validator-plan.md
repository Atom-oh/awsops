# Plan — W2b: AlertValidation Haiku worker + SM splice + incidents.tf

> 원천 / Source: spec §6 + W2 P2 gate (codex+glm+agy; fixes baked). **Stacked on W2a** (PR #101 — needs incidents.trigger_event + AlarmArn). W2b PR base = `feat/v2-alert-validation-w2`.
> Scope: connector_invoke 공유 추출 + AlertValidation 워커(신호+Haiku+억제안전) + SM ASL 스플라이스 + incidents.tf(Lambda/IAM/SSM). 전부 `local.il` 게이트(OFF=0/$0). 신호 read-only(ADR-006); SNS=W3. terraform apply는 컨트롤러; PR은 코드/.tf만.
> TDD red→green→commit. 테스트=pytest(scripts) + ASL JSON 단언.

## P2-gate fixes (코드 검증됨, 반드시 반영)
- Haiku modelId default `global.anthropic.claude-haiku-4-5-20251001-v1:0` (env `ALERT_VALIDATION_MODEL_ID`; bare id는 ap-northeast-2 ValidationException).
- SM `ResultPath: "$.validation"` + Choice on `$.validation.decision` (기존 스테이지 전부 ResultPath로 job_id/incident_id 보존).
- suppression_severity = **정규화된 snapshot.severity**(재유도 금지); critical → 절대 억제(CloudWatch ALARM=critical이므로 W2에선 CloudWatch 항상 escalate; Alertmanager warning/info 억제 적격).
- Haiku 입력 = isolatePayload 블록 + 신호는 `summarize_result` 출력만(label NAME/count/boolean; 원시값 금지). `_redact` PII.
- signal failure=non-2xx/timeout; 추적; **전부 실패/0신호 → uncertain**. global wall-clock deadline.
- IAM: `bedrock:InvokeModel` on `inference-profile/global.anthropic.claude-haiku-*`(+`foundation-model/anthropic.*`); connector `lambda:InvokeFunction` 5 ARN. fail-closed.

## File scope
scripts/v2/workers/connector_invoke.py(+test), scripts/v2/workers/diagnosis/sources.py, scripts/v2/incident/alert_validation.py(+test), scripts/v2/incident/incident.asl.json, scripts/v2/incident/test_incident.py, terraform/v2/foundation/incidents.tf, this plan.

### Task 1: Extract credential-blind connector_invoke (shared, DRY, test-first)

**Files:**
- Create: `scripts/v2/workers/connector_invoke.py`
- Create: `scripts/v2/workers/test_connector_invoke.py`
- Modify: `scripts/v2/workers/diagnosis/sources.py`
- Modify: `scripts/v2/workers/diagnosis/test_datasources.py`

- [ ] Test: `invoke_connector(kind, tool, instance_id, arguments)` builds the credential-blind payload `{tool_name, arguments{instance_id,...}}`, resolves `{PROJECT}-agent-{kind}-mcp`, parses `{statusCode, body}` (str body → json.loads, else {}); `summarize_result(body)` returns NON-PII signal-only (label NAMES/count/resultType, never raw values). (mock boto3 lambda client.)
- [ ] Impl: move `_invoke_connector`/`_summarize_result` (sources.py) into `connector_invoke.py` as public `invoke_connector`/`summarize_result`; `diagnosis/sources.py` imports + rebinds `_invoke_connector = invoke_connector`, `_summarize_result = summarize_result` (no behavior change).
- [ ] Verify: `cd scripts/v2/workers && PYTHONPATH=. python3 -m pytest test_connector_invoke.py diagnosis/test_datasources.py -q` green (test_datasources unchanged).
- [ ] Commit: `refactor(workers): extract credential-blind connector_invoke (shared, DRY) [W2b]`

### Task 2: AlertValidation worker — signals + Haiku + suppression safety (test-first)

**Files:**
- Create: `scripts/v2/incident/alert_validation.py`
- Create: `scripts/v2/incident/test_alert_validation.py`

`lambda_handler(event, _ctx)`, `event={incident_id, job_id?, attempt?}`. Read-only. Returns `{verdict, confidence, decision}` (SM reads `$.validation.decision`). Publishes nothing (W3).

Structure:
- `_load_trigger(conn, incident_id)` → snapshot dict | None (degrade-safe SELECT trigger_event).
- `collect_signals(snapshot, deadline)` → `{signals:[{source,summary}], failures:[src], count:int}`:
  - topology blast-radius: Aurora `topology_nodes/edges`, **account-scoped** (snapshot.account; bound the param like graph-query class binding) → {dependents}.
  - cloudwatch: boto3 GetMetricData around snapshot.timestamp for snapshot.metric → {recovered:bool, points}.
  - datasource connectors (best-effort): discover enabled default instances per kind (SELECT from integrations) → `invoke_connector` + `summarize_result`; non-2xx/timeout → failures.
  - global wall-clock deadline `ALERT_VALIDATION_DEADLINE_S` (25); per-call timeout; each isolated.
- `suppression_severity(snapshot)` = snapshot.severity (normalized).
- Haiku: `_bedrock_invoke(prompt)` mirror of rca_orchestrator (`global.anthropic.claude-haiku-4-5-20251001-v1:0`, anthropic_version, max_tokens 512, temperature 0, body.read, type=='text' join, botocore Config timeouts, fail-closed). prompt = isolatePayload block + summarize-only signals; `_redact`. tolerant JSON parse → `{verdict∈{real,uncertain,false_positive}, confidence, propagation, rationale}`; schema/parse fail → uncertain.
- decision = 'suppress' iff `verdict=='false_positive' AND confidence>=threshold(0.85, SSM) AND suppression_severity!='critical' AND signals.count>=2 AND not failures AND ALERT_SUPPRESSION_ENFORCE=='true'`; else 'escalate'. (shadow: enforce!=true → always 'escalate', verdict still recorded.) missing snapshot / 0 signals / all-fail → uncertain→escalate.
- record: `incident_findings`(sub_agent='alert-validator', findings=verdict json) + `UPDATE incidents SET validation=:v::jsonb, status=CASE WHEN decision='suppress' THEN 'false_positive' ELSE 'validating' END WHERE id=:id` (degrade-safe).

- [ ] Tests (mock boto3 bedrock + connector_invoke + pg8000 conn): never-suppress critical; shadow default→escalate; <2 signals→uncertain; signal-failure→uncertain; high-conf false + ≥2 + non-critical + enforce→suppress; Bedrock/parse exception→fail-closed escalate; prompt uses ONLY isolated block + summarized signals (assert no raw value/rawPayload in the prompt text); records validation + correct status.
- [ ] Verify: `cd scripts/v2/incident && PYTHONPATH=.:../workers python3 -m pytest test_alert_validation.py -q` green.
- [ ] Commit: `feat(incident): AlertValidation worker — Haiku true/false gate + suppression safety [W2b]`

### Task 3: SM ASL splice — AlertValidation + verdict Choice + Suppressed (test-first)

**Files:**
- Modify: `scripts/v2/incident/incident.asl.json`
- Modify: `scripts/v2/incident/test_incident.py`

- [ ] Test (parse ASL): `TriageDecision.Default == 'AlertValidation'`; Skipped/Linked still →Done; `AlertValidation` Task has `ResultPath == '$.validation'`, Retry/Catch→StageFailed, `Next == 'ValidationDecision'`; `ValidationDecision` Choice routes `$.validation.decision == 'suppress'`→`Suppressed`, Default→`Lead`; `Suppressed` is `Type: Succeed`; Lead's Retry/Catch unchanged.
- [ ] Impl: repoint `TriageDecision.Default`→`AlertValidation`; add `AlertValidation`(Task, `Resource: ${alert_validation_fn_arn}`, `ResultPath: $.validation`, Retry+Catch→StageFailed, Next: ValidationDecision), `ValidationDecision`(Choice), `Suppressed`(Succeed). Keep byte-identical-OFF concerns: this edits the committed JSON (AlertValidation is core lifecycle, not a gated overlay).
- [ ] Verify: `cd scripts/v2/incident && PYTHONPATH=.:../workers python3 -m pytest test_incident.py -q` green.
- [ ] Commit: `feat(incident): splice AlertValidation→verdict Choice→Suppressed into incident SM [W2b]`

### Task 4: incidents.tf — AlertValidation Lambda + IAM + SSM + packaging (terraform validate)

**Files:**
- Modify: `terraform/v2/foundation/incidents.tf`

- [ ] Impl (all `count=local.il`):
  - `aws_lambda_function.incident_alert_validation[0]` (role incident_lambda, py3.12, arm64, 512MB, pg8000 layer, vpc_config, env local.inc_env, handler `alert_validation.lambda_handler`).
  - `data.archive_file.incident_src`: add `source{}` for `alert_validation.py` + `connector_invoke.py`.
  - `aws_iam_role_policy.incident_lambda`: add `bedrock:InvokeModel` on `arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-haiku-*` + `arn:aws:bedrock:*:*:foundation-model/anthropic.*`; `lambda:InvokeFunction` on the 5 `${project}-agent-{prometheus,mimir,loki,tempo,clickhouse}-mcp` ARNs.
  - `aws_iam_role_policy.incident_sfn` InvokeIncidentLambdas: append the new Lambda ARN.
  - SSM (count=local.il, ignore_changes=[value]): `/ops/${project}/incident/validation-deadline-s`, `.../suppress-confidence-threshold`, `.../suppression-enforce`(default 'false'); add `*_PARAM` env to `local.inc_env_base` + ReadIncidentAndRuntimeParams resource list; `ALERT_VALIDATION_MODEL_ID` env (global.* default; no SSM).
  - `local.incident_def_off` templatefile var map: add `alert_validation_fn_arn`; reference in the ASL Resource.
- [ ] Verify: `terraform -chdir=terraform/v2/foundation fmt` + `validate` (plan = No changes when `incident_lifecycle_enabled=false`). No apply.
- [ ] Commit: `feat(incident): AlertValidation Lambda + IAM(bedrock+connector) + SSM tunables (gated) [W2b]`

## Out of scope
SNS publish=W3. source_allowlist UX=W4. CloudWatch 태그 억제 opt-in=후속. AWS mutation 없음(ADR-005).

## Fast-follow (deferred from PR #102 review — multi-AI panel consensus, repo issues disabled → tracked here)
Two real MAJORs were deferred (unanimous: Kiro · Codex · Agy · Claude chair). Feature is flag-OFF + shadow-default + fail-closed, so neither blocks merge. Correctness fixes already landed: M2 signal accounting + M3 confidence (`51e8880f`), CloudWatch `GetMetricData` IAM (`55389cfb`). The round-2 "CRITICAL no validation column" was a **false positive** — migration `01KVYC5ZYXG6SKQRECWCWQ05ZH_incident_validation_stage.sql` (on base, applied by `make migrate` before deploy) supplies the column + status CHECK; reviewers read the frozen `data/schema.sql`.

- [ ] **FF-A (HARD GATE before `incident_lifecycle_enabled=true`)** — tunables to SSM. `alert_validation.py` reads `ALERT_VALIDATION_DEADLINE_S` / `ALERT_SUPPRESS_CONFIDENCE_THRESHOLD` / `ALERT_SUPPRESSION_ENFORCE` from `os.environ` (import-time); `incidents.tf` hardcodes them as Lambda env. This is the **planned Task 4 SSM design that the impl skipped** — and `ALERT_SUPPRESSION_ENFORCE` is a safety knob that must be a live SSM toggle (cf. `ReadIncidentAndRuntimeParams` + the 5 `incident_*` params + `prevention_loop` live-read; PR #36 review). Scope: 3 `aws_ssm_parameter` (`ignore_changes=[value]`) + `*_PARAM` env + extend the IAM read statement + cached `get_parameters` live-read at handler entry + tests. **Must land before flag-on.**
- [ ] **FF-B (hardening, lower priority)** — label-value allowlist/DLP in `_build_prompt`. It serializes `labels` values (`str(v)[:120]`) + CloudWatch `last_value`; residual PII/injection risk outside the `_redact` patterns. Already mitigated (`_redact` arn/acct/ip/email/key, no rawPayload, summarize-only raw signals, untrusted-data framing). Fix = allowlist/DLP sanitizer on label **values**; do NOT strip to names-only — `last_value`/threshold/comparator are intentional comparator context for Haiku.
