# v2 Merge Verification / v2 머지 검증

이 게이트는 설계-대비-구현 감사에서 나온 v2 머지 불변식을 `feat/v2-architecture-design` →
`main` 머지 전에 실행 가능한 검증으로 고정한다.

- **S1**: `terraform/v2/foundation/`의 frozen/gated 리소스가 여전히 default-off이고
  `count`/`for_each`로 게이트되어 있는지, 추적된 tfvars가 게이트된 flag를 활성화하지
  않는지 확인 (`scripts/v2/merge_invariants.py`).
- **S2**: AgentCore catalog·web sections·route rules 9개 섹션 키가 정합하는지,
  `observability`→`external-obs` 별칭이 라우팅 양쪽(카탈로그+에이전트 런타임)에 있는지,
  v1 `/awsops/` 경로 리터럴이 web 소스에 누출되지 않는지 확인 (`web/lib/merge-invariants.ts`).
- **S3**: 파일 격리 pytest + web vitest + 기회적 terraform 체크를 하나의 러너로 묶고
  PR CI 게이트로 강제한다 (`scripts/v2/merge-verify.sh` + `.github/workflows/merge-verify.yml`).
- **S4**: 오프라인 PR 리뷰 테스트가 12개 셀의 nonce 결합 JSON 완료 프레임, 실제 보고서만
  chair로 전달되는 경계, 비정상 종료·타임아웃·하드킬·재시도·마스킹을 검증한다.

CI가 셀마다 생성한 32자리 소문자 hex nonce와 lens를 마지막 한 줄의
`REVIEW_COMPLETE: <lens> <nonce> {"report":"JSON 문자열"}`에 포함한다.
본문 줄바꿈·따옴표는 JSON으로 이스케이프한다. stdlib 파서는 현재 셀의 nonce를 가진
프레임만 세고 유일한 마지막 프레임·lens·엄격한 JSON을 검증한다. 앞선 다른 nonce의
프레임은 도구 출력으로 무시하며 보고서로 인정하지 않는다. 현재 프레임 뒤에 다른 nonce의
프레임이 있거나 현재 nonce가 중복·잘못된 lens로 나타나면 거부한다.
도구 헤더·Markdown fence·마커 예문으로 완료를 추정하지 않는다.
Kiro assistant 접두사와 숫자 footer 하나만 표시 형식으로 허용한다. CLI 성공 종료가 필수이며,
원본을 다시 검증한 뒤 디코딩된 본문만 제어문자 제거·마스킹하여 chair로 전달한다.
거부된 프레임의 인코딩된 payload는 preview에서 숨기고 나머지 진단은 마스킹 후 제한한다.
nonce는 실행 연결용 비밀이 아닌 값이며 권한이나 서명을 대체하지 않는다.

`merge-verify.yml`은 오프라인 PR 리뷰 테스트를 별도 단계로 실행한다.
`bash tests/run-all.sh`는 hook/structure·PR 리뷰·agent 테스트를 포함하는 로컬 전체 명령이며,
CI는 이 전체 명령을 실행하지 않는다. Fixture는 실제 AWS/AI를 호출하거나 전체 환경을 덤프하지 않는다.
AI 리뷰의 90분 상한, panel/chair 전 Pod Identity preflight, 기존 provider·서명·SDK 갱신 경로는 유지한다.

**알려진 한계 (patch 대상 아님, 문서화만)**: `ungated_resources()`는 리소스 body 안의
`count=`/`for_each=` 라인 존재만 확인한다 — 중첩된 `dynamic` 블록의 `for_each`만 있고
최상위 게이트가 없는 리소스는 이론상 검출을 통과할 수 있다. 현재 10개 게이트 파일 중
이 패턴으로 실제 발생하는 위양성은 0건(측정 완료)이지만, 최상위 속성만 인정하도록
좁히는 것은 후속 작업이다.

---

This gate turns the v2 merge invariants from the design audit into executable checks before merging
`feat/v2-architecture-design` to `main`.

**Known limitation (documented, not patched this round):** `ungated_resources()` only checks
for the presence of a `count=`/`for_each=` line anywhere in a resource body — a resource whose
only gate is a nested `dynamic` block's `for_each` (with no top-level gate) could theoretically
slip through undetected. Zero false negatives from this pattern exist across the current 10
gated files (measured), but narrowing the check to top-level attributes only is a follow-up.

## Scenarios

| Scenario | Invariant | Design source | Verification code path | Command |
| --- | --- | --- | --- | --- |
| S1 | Frozen and gated Terraform resources stay default-off, gated by `count` or `for_each`, and tracked tfvars do not enable gated flags. | `docs/decisions/BASELINE.md`, ADR-005, ADR-006, ADR-007 | `scripts/v2/test_merge_invariants.py`, `scripts/v2/merge_invariants.py` | `python3 -m pytest scripts/v2/test_merge_invariants.py -q` |
| S2 | The 9 routed sections align across AgentCore catalog, web sections, route rules, and the `observability` to `external-obs` alias; v1 `/awsops/` route literals do not leak into v2 web sources. | ADR-004, ADR-038 | `web/lib/merge-invariants.test.ts`, `web/lib/merge-invariants.ts` | `cd web && npx vitest run lib/merge-invariants.test.ts` |
| S3 | Merge verification runs the isolated Python suite, web vitest, opportunistic Terraform checks, and the PR CI gate. | 2026-07-05 v2 merge verification plan | `scripts/v2/merge-verify.sh`, `.github/workflows/merge-verify.yml` | `bash scripts/v2/merge-verify.sh` |
| S4 | All 12 cells require successful CLI exits and nonce-bound final report frames; only decoded, scrubbed reports reach the chair. | PR-review execution protocol | `scripts/pr-review/test_report_frame.py`, `scripts/pr-review/test_review_completion.py`, `scripts/pr-review/test_aws_preflight.py` | `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v` |

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

## Pytest Isolation

Do not replace the Python stage with a single aggregate `pytest scripts/v2 agent` command. The current
suite has known false positives when files share one Python process: tests mutate `sys.path` and
environment variables, and same-name helper modules such as `db` and `handlers` can collide. Running
each `test_*.py` file in its own pytest process preserves isolation and avoids the measured 57
aggregate-run false failures.

## CI Gate

`.github/workflows/merge-verify.yml` runs on pull requests targeting `main`. It checks out the PR,
sets up Node.js 20 and Python 3.12, installs web dependencies with `cd web && npm ci`, installs
`pytest` plus the v2 Python subsystem requirements, and executes `bash scripts/v2/merge-verify.sh`.
It also runs the offline PR-review regressions in a separate step:

```bash
python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v
```

For the local full suite (hooks, structure, offline PR review, and agent tests), run:

```bash
bash tests/run-all.sh
```

This full-suite command is not a step in `merge-verify.yml`.
These fixtures cover all 12 required model/lens reports, strict final JSON frames and nonces,
quoted/plain/fenced tool strings and static marker examples, numeric Kiro footers,
discarded nonzero/timed-out output, chair CLI exit status, retries, hard kills and decoded
session-token redaction. Captured L2/L4 bodies are historical roundtrip fixtures; they do
not approve the current parser or establish completion of the old runs. The fake matrix
checks all decoded reports reach the chair without chatter or truncation below the existing caps.
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

## Manual Gates Outside CI

Before the final merge, run the routing accuracy gate against real Bedrock:

```bash
node scripts/v2/routing-accuracy.mjs
```

This is the ADR-038 golden-set check and must remain at or above 85%.

Also run the production web build manually:

```bash
cd web && npm run build
```
