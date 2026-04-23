# ADR-027: Code Interpreter Session Isolation via AgentCore / AgentCore를 통한 코드 인터프리터 세션 격리

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops exposes a Python execution environment so the AI assistant can perform computation — plotting cost trends, aggregating Steampipe result sets, running statistics — beyond static prompt answers. Giving the model a REPL unlocks analytical flows that a text-only LLM cannot produce on its own, but arbitrary Python execution introduces sandboxing, dependency, and data-leak risks that must be bounded before the feature can ship to production.

AWSops는 AI 어시스턴트가 정적 프롬프트 응답을 넘어 비용 추이 플로팅, Steampipe 결과 집계, 통계 연산 같은 실제 계산을 수행할 수 있도록 Python 실행 환경을 제공한다. 모델에 REPL을 열어 주면 텍스트 전용 LLM 혼자서는 만들어 낼 수 없는 분석 흐름이 가능해지지만, 임의 Python 코드 실행은 샌드박싱·의존성·데이터 유출 위험을 수반하므로 프로덕션 투입 전 반드시 경계를 지어야 한다.

The feature also must line up with the existing AI routing contract documented in ADR-002, where priority 1 is the `code` route — meaning code-like prompts bypass the eight Gateways and land on the interpreter directly, and the isolation boundaries chosen here define the blast radius for every such request.

또한 이 기능은 ADR-002에 기술된 AI 라우팅 계약과 일치해야 한다. 우선순위 1은 `code` 라우트이므로 계산성 프롬프트는 8개 Gateway를 우회해 곧바로 인터프리터로 전달되며, 여기서 선택되는 격리 경계가 모든 요청의 영향 반경을 결정한다.

## Options Considered / 고려된 대안

### Option 1 — AgentCore Managed Code Interpreter (chosen) / AgentCore 관리형 코드 인터프리터 (채택)

Bedrock AgentCore ships a managed Python sandbox with pre-installed data-science libraries (numpy, pandas, matplotlib). Sessions are provisioned via `StartCodeInterpreterSessionCommand`, invoked with `InvokeCodeInterpreterCommand`, and torn down with `StopCodeInterpreterSessionCommand`. Billing is per invocation, execution happens inside AWS-managed infrastructure, and the EC2 host never sees the Python process.

Bedrock AgentCore는 numpy·pandas·matplotlib 등이 사전 설치된 관리형 Python 샌드박스를 제공한다. `StartCodeInterpreterSessionCommand`로 세션을 시작하고 `InvokeCodeInterpreterCommand`로 호출한 뒤 `StopCodeInterpreterSessionCommand`로 종료한다. 호출 단위 과금이며 실행은 AWS 관리형 인프라 내부에서 일어나고 EC2 호스트는 Python 프로세스를 전혀 보지 않는다.

### Option 2 — Self-managed Docker sandbox on EC2 / EC2 자체 관리형 Docker 샌드박스

Run Python in a hardened container (gVisor, seccomp, read-only root FS, no network) on the same EC2 that runs Next.js. AWSops would own the container runtime, the base image patches, and the lifecycle of arbitrary-code-execution targets sitting next to the production process.

Next.js를 구동하는 동일 EC2에서 gVisor·seccomp·읽기 전용 루트 FS·네트워크 차단으로 강화한 컨테이너 안에서 Python을 실행한다. 컨테이너 런타임, 베이스 이미지 패치, 그리고 프로덕션 프로세스 바로 옆에 위치한 임의 코드 실행 타깃의 수명 주기를 AWSops가 직접 소유해야 한다.

### Option 3 — Per-invocation Lambda runtime / 호출별 Lambda 런타임

Package Python + libraries into a Lambda layer and invoke a new execution per request. Each invocation is isolated by Lambda's Firecracker microVM, but the layer is capped at 250 MB unzipped and does not include plot rendering by default.

Python과 라이브러리를 Lambda 레이어로 패키징해 요청마다 새 실행을 호출한다. Lambda의 Firecracker microVM이 호출별 격리를 제공하지만 레이어는 압축 해제 시 250MB 상한이 있고 기본으로 플롯 렌더링 스택이 포함되지 않는다.

### Option 4 — Browser-side Pyodide (WebAssembly) / 브라우저 측 Pyodide (WebAssembly)

Ship Pyodide to the client and execute the AI-generated code in the user's browser. No server-side execution risk at all.

Pyodide를 클라이언트에 전송해 AI가 생성한 코드를 사용자 브라우저에서 실행한다. 서버 측 실행 위험이 전혀 없다.

## Decision / 결정

Adopt Option 1: AgentCore-managed Code Interpreter with ephemeral, per-request sessions. The `POST /api/code` route (see `src/app/api/code/route.ts`) starts a session, runs exactly one `executeCode` invocation, streams results back, and calls `StopCodeInterpreterSessionCommand` in a `finally`-equivalent cleanup path so that an aborted request cannot leak a session. The same pattern is mirrored inside `src/app/api/ai/route.ts` for AI-driven invocations so that priority-1 routing still produces the same isolation guarantees.

Option 1(AgentCore 관리형 코드 인터프리터, 요청당 임시 세션)을 채택한다. `POST /api/code` 라우트(`src/app/api/code/route.ts` 참조)는 세션을 시작하고 `executeCode`를 정확히 한 번 호출한 뒤 결과를 스트리밍으로 받아 `StopCodeInterpreterSessionCommand`를 `finally` 등가 경로에서 호출한다. 따라서 중단된 요청도 세션을 누수시킬 수 없다. `src/app/api/ai/route.ts` 내부에서도 동일 패턴이 반복되어 우선순위 1 라우팅이 같은 격리 보증을 만든다.

Provisioning lives in `scripts/06d-setup-agentcore-interpreter.sh`, which creates a single Code Interpreter named `awsops_code_interpreter` with `networkConfiguration: { networkMode: "PUBLIC" }`. The resulting identifier is persisted into `data/config.json` as `codeInterpreterName`, read at runtime via `getConfig().codeInterpreterName`.

프로비저닝은 `scripts/06d-setup-agentcore-interpreter.sh`에 있으며 `networkConfiguration: { networkMode: "PUBLIC" }`로 단일 Code Interpreter를 `awsops_code_interpreter` 이름으로 생성한다. 반환된 식별자는 `data/config.json`의 `codeInterpreterName` 필드에 저장되고 런타임에서는 `getConfig().codeInterpreterName`을 통해 읽힌다.

## Rationale / 근거

Self-managed sandboxing (Option 2) moves the hardest security problem — arbitrary code execution — into a process that shares a kernel with the Next.js server; an escape would compromise the Cognito-authenticated dashboard host. Lambda (Option 3) solves isolation but loses the plotting library set and forces layer-size engineering for every dependency update. Pyodide (Option 4) cannot reach Steampipe results unless they are first shipped to the browser, which defeats the server-side data-loading model used by every other AWSops page and lets users bypass the AI's analysis prompt. The managed interpreter keeps the blast radius inside AWS-operated infrastructure, reuses AWSops's existing IAM posture, and requires no custom container maintenance.

자체 관리형 샌드박싱(Option 2)은 가장 어려운 보안 문제(임의 코드 실행)를 Next.js 서버와 커널을 공유하는 프로세스로 끌어들인다. 탈옥이 발생하면 Cognito 인증을 거친 대시보드 호스트가 통째로 침해된다. Lambda(Option 3)는 격리는 해결하지만 플로팅 라이브러리 세트를 잃고 의존성 업데이트마다 레이어 용량 엔지니어링을 강요한다. Pyodide(Option 4)는 Steampipe 결과를 브라우저로 먼저 보내지 않는 한 접근 불가능하며, 이는 다른 AWSops 페이지의 서버 측 로딩 모델을 무너뜨리고 사용자가 AI 분석 프롬프트를 우회하도록 허용한다. 관리형 인터프리터는 영향 반경을 AWS 운영 인프라 내부에 묶어 두고 기존 IAM 설계를 재사용하며 커스텀 컨테이너 유지 보수를 요구하지 않는다.

Per-request sessions were chosen over long-lived workspaces because AWSops has no "notebook" concept; every AI message is independent, and persistent state would allow one user's intermediate variables to influence another user's next answer. Ephemerality also caps cost: there is no idle sandbox waiting for the next question.

장기 지속 워크스페이스 대신 요청당 세션을 택한 이유는 AWSops에 "노트북" 개념이 없기 때문이다. 모든 AI 메시지는 독립적이며, 영속 상태를 두면 한 사용자의 중간 변수가 다른 사용자의 다음 응답에 영향을 줄 수 있다. 비영속성은 비용 상한도 제공한다 — 다음 질문을 기다리는 유휴 샌드박스가 없다.

The Code Interpreter name uses underscores only (`awsops_code_interpreter`) because AgentCore enforces `[a-zA-Z][a-zA-Z0-9_]+` on resource names — this is a platform constraint, not a style preference, and it is called out in the root CLAUDE.md "AgentCore Known Issues" section so operators do not regress the naming during re-provisioning.

Code Interpreter 이름이 언더스코어만 사용(`awsops_code_interpreter`)하는 것은 AgentCore가 리소스 이름에 `[a-zA-Z][a-zA-Z0-9_]+`를 강제하기 때문이다. 이는 플랫폼 제약이지 취향 문제가 아니며, 재프로비저닝 시 네이밍 회귀를 막기 위해 루트 CLAUDE.md "AgentCore Known Issues" 섹션에도 명시되어 있다.

Routing computational prompts directly to the interpreter — skipping the eight Gateways defined in ADR-004 — keeps latency low (no MCP round-trip) and keeps analytical workloads separate from data-retrieval workloads. Gateways are for AWS API access; the interpreter is for numerical/plotting work on data the model already has in context.

계산성 프롬프트를 ADR-004의 8개 Gateway를 건너뛰고 인터프리터로 직결시키는 것은 지연을 낮추고(MCP 왕복 제거) 분석 작업과 데이터 조회 작업을 분리한다. Gateway는 AWS API 접근용, 인터프리터는 이미 컨텍스트에 들어온 데이터에 대한 수치·플로팅 처리용이다.

## Security Considerations / 보안 고려 사항

The AgentCore sandbox is isolated from the EC2 host entirely — Python in the session cannot reach the Next.js file system, the Steampipe socket, or the host IAM role. Outbound internet access is governed by the `networkConfiguration` attached at create time; the current setting is `PUBLIC` for egress-only library fetches, and there is no inbound path from the sandbox to AWSops. Image outputs returned by the stream are surfaced through the Next.js API response, never as a direct signed URL to the sandbox's temporary S3 bucket, which means the client never acquires credentials for anything that lives outside AWSops's own allowlist.

AgentCore 샌드박스는 EC2 호스트와 완전히 분리된다. 세션 내부 Python은 Next.js 파일 시스템, Steampipe 소켓, 호스트 IAM 역할 어디에도 도달할 수 없다. 외부 인터넷 접근은 생성 시 지정한 `networkConfiguration`으로 통제되며 현재 설정은 egress 전용 라이브러리 페칭을 위한 `PUBLIC`이고, 샌드박스에서 AWSops로 향하는 inbound 경로는 없다. 스트림이 반환한 이미지 출력은 Next.js API 응답을 통해 전달되며 샌드박스 임시 S3 버킷의 서명 URL을 클라이언트에 직접 넘기지 않는다. 결과적으로 클라이언트는 AWSops allowlist 바깥의 자격 증명을 절대 획득하지 않는다.

Session state is ephemeral: a new session is created on each request and stopped before the HTTP response returns, including on exception paths. There is no cross-user variable leak by construction, and lost sessions — for example from a Node.js process crash — are bounded by AgentCore's own idle timeout and do not accumulate on the host. Session management APIs (enumeration, forcible termination) are not exposed to end users; regular callers can only invoke code within the session their own request created.

세션 상태는 일시적이다. 요청마다 새 세션이 만들어지고 HTTP 응답 반환 전(예외 경로 포함)에 중지된다. 구조적으로 사용자 간 변수 누수가 없으며, Node.js 프로세스 크래시 등으로 유실된 세션도 AgentCore 자체 유휴 타임아웃으로 경계되어 호스트에 누적되지 않는다. 세션 관리 API(열거·강제 종료)는 일반 사용자에게 노출되지 않으며, 일반 호출자는 자신이 만든 세션 안에서만 코드를 실행할 수 있다.

## Consequences / 결과

### Positive / 긍정적

- No Python sandbox maintenance on the EC2 host: no container image patching, no seccomp profile drift, no Python toolchain in the AWSops deployment artifact. / EC2 호스트에 Python 샌드박스 유지 보수가 없다. 컨테이너 이미지 패치, seccomp 프로파일 드리프트, 배포 아티팩트 내 Python 툴체인 모두 불필요하다.
- Per-invocation billing aligns cost with use — an idle dashboard costs zero sandbox dollars. / 호출 단위 과금이 사용량과 비용을 일치시킨다. 유휴 대시보드는 샌드박스 비용이 0이다.
- Ephemeral sessions eliminate cross-user variable leaks by construction. / 임시 세션이 사용자 간 변수 누수를 구조적으로 제거한다.
- Built-in numpy/pandas/matplotlib removes the dependency-packaging problem that Lambda/Docker options would have introduced. / 내장된 numpy·pandas·matplotlib가 Lambda·Docker 방안이 가져왔을 의존성 패키징 문제를 없앤다.
- Matches the priority-1 routing contract from ADR-002 with zero extra glue between routing and execution. / ADR-002의 우선순위 1 라우팅 계약과 일치하며 라우팅·실행 사이 추가 접착 코드가 필요 없다.

### Negative / 부정적

- AgentCore Code Interpreter is region-gated and must match the primary AWSops region (`ap-northeast-2` in `src/app/api/code/route.ts`); expanding regions requires a new interpreter per region. / AgentCore Code Interpreter는 리전 제한이 있어 AWSops 주 리전(`src/app/api/code/route.ts`의 `ap-northeast-2`)과 일치해야 하며 리전 확장 시 리전별 인터프리터가 필요하다.
- Cold-start latency on new sessions adds seconds to first-token time compared with a warm container. / 새 세션 콜드 스타트가 따뜻한 컨테이너 대비 첫 토큰까지의 시간을 수 초 늘린다.
- No long-running computation — the managed session enforces its own timeout; jobs that would take minutes must be decomposed or redirected to a batch path. / 장시간 연산이 불가능하다. 관리형 세션이 자체 타임아웃을 강제하므로 분 단위 작업은 분해하거나 배치 경로로 리다이렉트해야 한다.
- Library availability depends on AWS's interpreter image; arbitrary `pip install` at runtime is not supported. / 라이브러리 가용성이 AWS 인터프리터 이미지에 종속되며 런타임 임의 `pip install`은 지원되지 않는다.
- Output format is constrained to what Code Interpreter returns (text blocks plus image attachments); richer formats require post-processing in the Next.js layer. / 출력 포맷은 Code Interpreter가 반환하는 텍스트 블록과 이미지 첨부로 제한되며 더 풍부한 포맷은 Next.js 레이어의 후처리가 필요하다.

## References / 참고 자료

- `src/app/api/code/route.ts` — session start / invoke / stop lifecycle and error-path cleanup / 세션 시작·호출·중지 수명 주기 및 오류 경로 정리
- `src/app/api/ai/route.ts` — `executeCodeInterpreter()` mirrored inside priority-1 routing / 우선순위 1 라우팅에 복제된 `executeCodeInterpreter()`
- `scripts/06d-setup-agentcore-interpreter.sh` — provisioning and the underscore-only naming rule / 프로비저닝과 언더스코어 전용 네이밍 규칙
- Root `CLAUDE.md` "AgentCore Known Issues" — Code Interpreter name constraint and network configuration requirement / 루트 `CLAUDE.md` "AgentCore Known Issues" — 코드 인터프리터 이름 제약 및 네트워크 설정 요구
- ADR-002: AI Hybrid Routing — priority 1 `code` route feeds this interpreter / AI 하이브리드 라우팅 — 우선순위 1 `code` 라우트가 본 인터프리터로 전달
- ADR-004: Gateway Role Split — Code Interpreter intentionally bypasses Gateways / Gateway 역할 분리 — Code Interpreter는 Gateway를 의도적으로 우회
- ADR-016: Bedrock Model Selection Strategy — interpreter output is consumed by Sonnet/Opus depending on flow / Bedrock 모델 선택 전략 — 인터프리터 출력은 흐름에 따라 Sonnet/Opus가 소비
