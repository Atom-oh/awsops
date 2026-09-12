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
bash tests/run-all.sh  # full hook/structure + offline PR-review + agent suite
```

These fixtures cover all 12 required model/lens reports, matching final completion markers,
Kiro tool-output/body separation and its numeric footer, discarded nonzero/timed-out output,
chair/scrubber exit status, retries, hard kills, and labeled session-token redaction.
No fixture calls live AWS or AI services or dumps the full environment.

The AI-review workflow has a 90-minute ceiling and runs `preflight-aws-session.py` before
both panel and chair. Using the existing AWS CLI, preflight requires the ambient
`container-role` provider and a successful signed `sts get-caller-identity` call, so
invalid/expired credentials fail closed. It preserves EKS Pod Identity, profiles and signing
settings; it neither exports credentials to `GITHUB_ENV`/files nor forces renewal or a
45-minute cached-lease floor. Subsequent model CLIs retain their SDK refresh path.

`merge-verify.yml`은 위 오프라인 PR 리뷰 테스트도 별도 단계로 실행하며,
`bash tests/run-all.sh`에는 hook/structure·PR 리뷰·agent 테스트가 모두 포함된다.
Fixture는 12개 필수 보고서와 완료 마커, Kiro 도구 출력/본문 구분과 숫자 footer,
비정상 종료·타임아웃 출력 폐기, chair/scrubber 종료 상태, 재시도·하드킬,
세션 토큰 마스킹을 검증한다. 실제 AWS/AI 호출이나 전체 환경 덤프는 없다.

AI 리뷰 워크플로의 상한은 90분이며 panel/chair 전에 `preflight-aws-session.py`를 실행한다.
기존 AWS CLI가 선택한 `container-role` provider와 서명된 `sts get-caller-identity` 성공을
확인해 무효·만료 세션을 차단한다. EKS Pod Identity·프로필·서명 설정을 유지하며,
자격 증명을 `GITHUB_ENV`나 파일로 내보내거나 갱신·45분 잔여 시간을 강제하지 않는다.
후속 모델 CLI는 기존 SDK 자동 갱신 경로를 유지한다.

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
