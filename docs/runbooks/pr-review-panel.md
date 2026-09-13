# Runbook — AI PR-Review 패널 Kiro 셀 장애 / AI PR-Review Panel — Kiro Cells

lens×model 패널(`scripts/pr-review/run-panel.sh`, `.github/workflows/pr-review.yml`)의 Kiro 절반이
시작 검증에 실패하거나 non-transient 원인으로 응답을 멈췄을 때의 증상과 조치를 다룬다. 모든
증상은 PR 리뷰 코멘트 맨 위의 배너와 Actions 로그의 `::error::` 줄로 드러난다. 12셀 전부가
필수이므로(`scripts/CLAUDE.md`) 빠진 Kiro 셀은 항상 `VERDICT: FAIL` 로 강제된다 — 아래 조치는
"왜" 를 읽고 원인을 제거하는 절차이며, 게이트를 우회하는 절차가 아니다.

This runbook covers the Kiro half of the lens×model panel (`scripts/pr-review/run-panel.sh`,
`.github/workflows/pr-review.yml`) failing its startup check or stopping for a non-transient reason.
Every symptom is surfaced as a banner at the top of the PR review comment and an `::error::` line in
the Actions log. All 12 cells are required (`scripts/CLAUDE.md`), so a missing Kiro cell always forces
`VERDICT: FAIL` — the steps below explain *why* and remove the cause; none of them bypasses the gate.

이 시그니처들은 **Kiro stderr 에서만** 해석한다. Codex 도 입력 diff 를 stderr 에 그대로 찍을 수
있어, 인용된 Kiro 에러 문구가 정상 Codex 리뷰를 폐기하거나 재시도를 막으면 안 된다.

These signatures are interpreted **only in Kiro stderr**. Codex also echoes the reviewed diff to
stderr, where quoted Kiro errors must not discard a valid review or prevent a retry.

## 0. 이 repo 의 Kiro 툴 계약 / This repo's Kiro tool contract

형제 repo(aws-fsi-demo, ttobak, claude-code-usage-dashboard)와 달리 이 repo 의 Kiro 셀은 **무툴이
아니다**. diff 는 파일 경로로 전달되고(kiro-cli headless `chat` 은 stdin 을 읽지 않고, argv 임베드는
커널 MAX_ARG_STRLEN 에 걸린다) 렌즈 프롬프트의 BASE CONTEXT 규칙은 base 체크아웃을 직접 읽어 "없음"
오탐을 걸러내라고 요구한다. 그래서 계약은 **read + grep 만** 이며, 이를
`scripts/pr-review/agents/pr-review-readonly.json`(`tools` = `allowedTools` = `["read","grep"]`,
MCP/resources/hooks 없음)에 고정하고 `--agent pr-review-readonly` 로 넘긴다. 실행 시 이 파일은
셀 cwd(base 체크아웃)의 `.kiro/agents/` 로 복사되고 끝나면 삭제된다(`.gitignore` 등록).

Unlike the sibling repos (aws-fsi-demo, ttobak, claude-code-usage-dashboard) the Kiro cells here are
**not zero-tool**. The diff is delivered as a file path (headless `kiro-cli chat` ignores stdin and
argv embedding hits the kernel MAX_ARG_STRLEN cap) and the lens prompts' BASE CONTEXT rule requires
reading the base checkout to filter false "missing" findings. The contract is therefore **read + grep
only**, pinned in `scripts/pr-review/agents/pr-review-readonly.json` (`tools` = `allowedTools` =
`["read","grep"]`, no MCP/resources/hooks) and passed via `--agent pr-review-readonly`. At run time
the file is copied into the cell cwd's `.kiro/agents/` (the base checkout) and removed afterwards
(listed in `.gitignore`).

`--trust-tools=read,grep,fs_read` 는 더 이상 쓰지 않는다: kiro-cli 2.11.1 은 알 수 없는 이름(빈
문자열, 옛 `fs_read`)을 커스텀 툴로 해석해 `WARNING: --trust-tools arg for custom tool  needs to be
prepended with @{MCPSERVERNAME}/` 만 찍고 무시하며 기본 에이전트의 신뢰(cwd 안 read/glob/grep/code,
읽기 전용 aws)는 그대로 남는다. `--v3`/`--agent-engine v3` 는 에이전트의 `tools` 목록을 무시하므로
패널은 기본 v2 엔진을 유지한다(v3 전용 `--mode default` 도 쓰지 않음).

`--trust-tools=read,grep,fs_read` is no longer used: kiro-cli 2.11.1 parses unknown names (the empty
string, the stale `fs_read`) as custom tools, prints `WARNING: --trust-tools arg for custom tool  needs
to be prepended with @{MCPSERVERNAME}/` and ignores them, while the default agent's trust (read/glob/
grep/code inside the cwd, read-only aws) stays active. `--v3`/`--agent-engine v3` ignores the agent's
`tools` list, so the panel stays on the default v2 engine (and does not use the v3-only `--mode default`).

## 1. 시작 검증 / Startup verification (preflight)

Kiro 리뷰가 시작되기 전에 각 모델(`claude-opus-5`, `gpt-5.6-terra`)이 diff 없는 고정 프롬프트
("Reply with exactly PONG …")를 같은 에이전트로 한 번 받는다. 통과 조건: exit 0, stderr 에
폴백/한도 시그니처 없음, 응답에 `PONG`. 두 모델 모두 통과해야 어느 쪽에도 PR 입력이 간다. 실행당
최대 2회의 모델 호출이 추가되며 각각 `KIRO_PREFLIGHT_TIMEOUT`(기본 120s)로 제한된다. 실패하면
Kiro 8셀은 모두 건너뛰고(`[skip] … preflight failed`) Codex 4셀은 계속 돌며, `kiro-preflight.flag`
+ `coverage-severe.flag` 가 남는다. 사후 폴백 감지(아래 B)는 추가 안전장치로 유지된다.

Before any Kiro review starts, each model (`claude-opus-5`, `gpt-5.6-terra`) receives one fixed
prompt without the diff ("Reply with exactly PONG …") using the same agent. Passing requires exit 0,
no fallback/quota signature in stderr and `PONG` in the reply. Both models must pass before either
receives PR input. This adds at most two model calls per run, each bounded by `KIRO_PREFLIGHT_TIMEOUT`
(default 120s). On failure all 8 Kiro cells are skipped (`[skip] … preflight failed`), the 4 Codex
cells keep running, and `kiro-preflight.flag` + `coverage-severe.flag` are written. Post-execution
fallback detection (B below) remains an additional safeguard.

## 2. 증상 A — `🚫 Kiro 월간 요청 한도 소진 / Kiro monthly request quota exhausted`

로그 / Log: `::error::Kiro monthly request quota exhausted for KIRO_API_KEY — … The limits reset on
MM/DD`. 모든 Kiro 셀이 재시도 없이 건너뛰어지고(`[quota] kiro-…`) `codex/L2..L5` 만 응답한다.
Every Kiro cell is skipped without retry (`[quota] kiro-…`); only `codex/L2..L5` respond.

원인 / Cause: `KIRO_API_KEY` 뒤의 Kiro 계정이 `ServiceQuotaExceededException
reason=MONTHLY_REQUEST_COUNT` 를 반환했다. v2 엔진은 이를 stderr `Monthly request limit reached` +
rc=0 + 빈 stdout 으로 보고하므로 시그니처 감지가 없으면 "빈 응답"처럼 보인다. 키는 Secrets Manager
`/demo-platform/actions/AI-key`(AWS-Demo-Platform 저장소, ExternalSecret `ai-panel-keys`)에 있고
`actions-runner-claude` 이미지로 PR 리뷰를 돌리는 **모든 repo 가 공유**하므로, 어느 한 repo 의
바쁜 한 달이 전부를 소진시킨다. headless 플래그 문제가 아니다.
The Kiro account behind `KIRO_API_KEY` returned `ServiceQuotaExceededException
reason=MONTHLY_REQUEST_COUNT`. The v2 engine reports it as stderr `Monthly request limit reached` +
rc=0 + empty stdout, which looks like an empty response without signature detection. The key lives in
Secrets Manager `/demo-platform/actions/AI-key` (AWS-Demo-Platform repo, ExternalSecret
`ai-panel-keys`) and is **shared by every repo** whose PR review runs on the `actions-runner-claude`
image, so one busy month anywhere exhausts it for all. It is not a headless-flag problem.

조치(계정 측에서만 가능 — 이 repo 의 코드로는 해소 불가) / Fix (account-side only):
1. 키를 소유한 Kiro 계정에서 overage 를 활성화하거나, 한도가 남은 계정의 키를 발급해
   `/demo-platform/actions/AI-key` 의 `KIRO_API_KEY` 를 교체한다(ESO 가 러너 시크릿을 갱신하고 새
   러너 파드가 이를 집어간다). / Enable overages on the owning Kiro account, **or** issue a key from an
   account with remaining quota and update `KIRO_API_KEY` in `/demo-platform/actions/AI-key` (ESO
   refreshes the runner secret; new runner pods pick it up).
2. 실패한 `AI Code Review` 워크플로를 재실행한다(또는 PR 에 push). Kiro 셀이 다시 응답하면 배너가
   사라진다. / Re-run the failed `AI Code Review` workflow (or push to the PR). The banner disappears
   when Kiro cells respond again.
3. 아무것도 하지 않으면 배너에 찍힌 날짜에 한도가 리셋된다. / If nothing is done, the quota resets on
   the date printed in the banner.

CI 분 소비 없이 로컬 확인(키를 절대 echo 하지 말 것) / Verify locally without spending CI minutes
(never echo the key):
```bash
K=$(aws secretsmanager get-secret-value --secret-id /demo-platform/actions/AI-key \
      --region ap-northeast-2 --query SecretString --output text | jq -r .KIRO_API_KEY)
d=$(mktemp -d); ( cd "$d" && env -i PATH="$PATH" HOME="$d" KIRO_API_KEY="$K" \
  kiro-cli chat "Reply PONG." --model gpt-5.6-terra --no-interactive --wrap never )
# exhausted → stderr "Monthly request limit reached", empty stdout, exit 0
```

## 3. 증상 B — `🔓 Kiro 에이전트 계약 위반 / Kiro agent contract broken`

로그 / Log: `::error::kiro-cli ignored --agent pr-review-readonly (fell back to the default agent)
…`. 해당 셀의 응답은 비어 있지 않아도 폐기된다. / Kiro responses are discarded even if non-empty.

원인 / Cause: kiro-cli 가 `Error: no agent with name pr-review-readonly found. Falling back to user
specified default` 를 찍고(에이전트 파일 부재, 잘못된 JSON, 러너의 kiro-cli 버전이 거부하는 스키마
모두 이 메시지) rc=0 으로 기본 에이전트를 계속 실행했다. 기본 에이전트는 cwd 안 read/glob/grep/code
와 읽기 전용 `aws` 호출을 신뢰하므로 이 repo 의 read+grep 계약보다 넓다 — diff 는 신뢰할 수 없는
입력이라 이를 계약 위반으로 취급한다.
kiro-cli printed `Error: no agent with name pr-review-readonly found. Falling back to user specified
default` (a missing agent file, invalid JSON, or an agent schema the runner's kiro-cli rejects all
produce it) and continued with the default agent at rc=0. The default agent trusts read/glob/grep/code
inside the cwd plus read-only `aws` calls, which is wider than this repo's read+grep contract — the
diff is untrusted input, so this is treated as a broken contract.

조치 / Fix:
1. 패널 스텝 첫 줄에 찍힌 kiro-cli 버전(`run-panel.sh: kiro-cli X.Y.Z`)을 에이전트 파일이 검증된
   버전(2.11.1)과 비교한다. / Compare the kiro-cli version printed on the first line of the panel step
   (`run-panel.sh: kiro-cli X.Y.Z`) with the version the agent file was validated with (2.11.1).
2. 그 버전으로 파일을 검증한다(주의: 2.11.1 의 `validate` 는 중복 키 같은 오류를 stderr 에 찍고도
   rc=0 을 반환하므로 출력을 읽어야 한다) / Validate the file with that version (note: 2.11.1's
   `validate` prints errors such as duplicate keys to stderr yet returns rc=0, so read the output):
   `kiro-cli agent validate --path scripts/pr-review/agents/pr-review-readonly.json`
3. 다른 것을 바꾸기 전에 읽기 전용 동작을 재확인한다 / Re-verify the read-only behaviour before
   changing anything else:
   ```bash
   d=$(mktemp -d); mkdir -p "$d/.kiro/agents"
   cp scripts/pr-review/agents/pr-review-readonly.json "$d/.kiro/agents/"
   echo CANARY > "$d/notes.txt"
   ( cd "$d" && kiro-cli chat "Read ./notes.txt and print it, then run 'id' with a shell tool. If a tool is unavailable say NO_TOOL_<name>." \
       --agent pr-review-readonly --model gpt-5.6-terra --no-interactive --wrap never )
   # expected: CANARY printed via "using tool: read"; NO_TOOL_shell (no shell/aws/write tool use)
   ```
4. `--v3` / `--agent-engine v3` 로 우회하지 **말 것**: v3 엔진은 에이전트의 `tools` 목록을 무시한다.
   / Do **not** switch to `--v3` / `--agent-engine v3` to work around it: the v3 engine ignores the
   agent's `tools` list.

## 4. 증상 C — `🛑 Kiro 사전 검증 실패 / Kiro preflight failed`

`kiro-preflight.flag` 배너는 고정 시작 검증이 계약을 확인하지 못했다는 뜻이며, Kiro 에는 PR 입력이
전혀 가지 않았다. Actions 로그의 preflight stderr 를 본다: 한도와 에이전트 폴백은 각자의 배너(A/B)를
함께 띄우고, 타임아웃·인증 오류·`PONG` 이 아닌 응답도 검증을 실패시킨다. 보고된 원인을 해결하고 CI 를
재실행한다. preflight 를 우회하지 말 것.

The `kiro-preflight.flag` banner means the fixed startup check did not confirm the contract; no PR
input was sent to Kiro. Inspect the preflight stderr in the Actions log: quota and agent fallback also
raise their own banners (A/B); timeouts, authentication errors and a non-`PONG` reply fail the check
too. Resolve the reported cause, then rerun CI. Do not bypass the preflight.

잘못된 에이전트 JSON(중복 키 포함), read/grep 이외의 툴, MCP/resources/hooks 설정, 허용 목록 밖의
키, 또는 에이전트 파일 복사 실패는 모델을 하나도 호출하지 않고 패널 스텝을 rc=1 로 중단시킨다 —
실패한 스텝 로그에 `invalid read-only agent configuration` / `failed to install kiro agent` 로 나온다.

Malformed agent JSON (including duplicate keys), tools other than read/grep, MCP/resources/hooks
settings, keys outside the allowlist, or a failed agent copy abort the panel step with rc=1 before
any model is called — visible in the failed step log as `invalid read-only agent configuration` /
`failed to install kiro agent`.

러너 이미지와 CLI 버전은 AWS-Demo-Platform 저장소의 `docker/actions-runner-claude/Dockerfile` 이
관리한다(unpinned vendor-latest); 이미지 고정/재빌드는 이 repo 의 리뷰 스크립트와 별개의 변경이다.
The runner image and CLI version are managed in the AWS-Demo-Platform repository's
`docker/actions-runner-claude/Dockerfile` (unpinned vendor-latest); pinning or rebuilding that image
is a separate change from this repository's review scripts.

## Related

- Scripts: `scripts/pr-review/run-panel.sh`, `scripts/pr-review/synthesize.sh`,
  `scripts/pr-review/agents/pr-review-readonly.json`, `scripts/CLAUDE.md`
- Tests: `tests/structure/test-pr-review-panel.sh`, `tests/structure/test-pr-review-panel-prompt.sh`,
  `scripts/pr-review/test_review_completion.py`
- Workflow: `.github/workflows/pr-review.yml`
- Origin of the fix: claude-code-usage-dashboard 저장소의 PR #33 (sibling ports: aws-fsi-demo #509,
  ttobak #193); the v2-engine decision matches AWS-Demo-Platform 저장소의 ADR-011 (unrelated to this
  repo's own ADR-011).
- ADR-005 (`docs/decisions/005-aws-mutation-autonomy-frozen.md`): the read-only contract of every
  automated AWS-touching path in this repo, which the agent's tool grant (no `aws` tool) also respects.
