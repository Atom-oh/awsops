# ADR-018: AgentCore Memory Store — Per-User Isolation and 365-Day Retention / AgentCore Memory — 사용자별 격리와 365일 보관

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops persists AI assistant conversation history in two places: a local file-backed store at `data/memory/` and the AgentCore Memory Store provisioned by `scripts/06f-setup-agentcore-memory.sh`. The local store serves the dashboard UI (history list, keyword search, per-session replay), while AgentCore Memory feeds the Strands agent running inside the AgentCore Runtime container so it can reason over prior sessions. Two defaults had to be chosen explicitly: the retention window and the isolation scope. Neither the platform default nor a simple "keep everything shared" approach fit a multi-operator SRE/MSP workflow where conversations embed customer-specific context (resource IDs, IAM policies, account IDs, AZ counts).

AWSops는 AI 어시스턴트 대화 이력을 두 곳에 저장한다. 로컬 파일 저장소(`data/memory/`)와 `scripts/06f-setup-agentcore-memory.sh`로 프로비저닝되는 AgentCore Memory Store다. 로컬 저장소는 대시보드 UI(이력 목록, 키워드 검색, 세션별 재생)를, AgentCore Memory는 AgentCore Runtime 컨테이너 내부의 Strands 에이전트가 이전 세션을 참조할 수 있게 한다. 두 가지 기본값 — 보관 기간과 격리 범위 — 을 명시적으로 선택해야 했다. 고객별 컨텍스트(리소스 ID, IAM 정책, 계정 ID, AZ 수)가 대화에 포함되는 멀티 운영자 SRE/MSP 환경에서는 플랫폼 기본값이나 "모두 공유" 접근이 적합하지 않다.

## Decision / 결정

Use dual storage with a single shared AgentCore Memory resource namespaced by Cognito user id, and configure `eventExpiryDuration` to the AgentCore maximum of 365 days.

단일 AgentCore Memory 리소스를 Cognito 사용자 ID로 네임스페이스 분리하는 이중 저장 구조를 채택하고, `eventExpiryDuration`을 AgentCore 최대값인 365일로 설정한다.

AgentCore Memory provisioning (`scripts/06f-setup-agentcore-memory.sh`):

```bash
MEMORY_NAME="awsops_memory"            # underscores only (AgentCore naming constraint)
aws bedrock-agentcore-control create-memory \
  --name "$MEMORY_NAME" \
  --description "AWSops AI Assistant conversation history" \
  --event-expiry-duration 365 \
  --region "$REGION"
```

Conversation record shape (`src/lib/agentcore-memory.ts`):

```typescript
export interface ConversationRecord {
  id: string;
  userId: string;          // Cognito sub or email, extracted by auth-utils.ts
  timestamp: string;
  route: string;
  gateway: string;
  question: string;
  summary: string;
  usedTools: string[];
  responseTimeMs: number;
  via: string;
}
```

All read paths (`getConversations`, `searchConversations`, `listSessions`) filter by `userId`. Writes are fire-and-forget from `src/app/api/ai/route.ts` so AI request latency is never blocked by memory I/O.

모든 읽기 경로(`getConversations`, `searchConversations`, `listSessions`)는 `userId`로 필터링한다. 쓰기는 `src/app/api/ai/route.ts`에서 fire-and-forget 방식으로 호출되어 AI 요청 지연에 영향을 주지 않는다.

## Rationale / 근거

**Dual storage (local + AgentCore).** The local file store is authoritative for the dashboard UI because it is fast (single JSON read, no cross-region hop), predictable (O(files) full-text scan), and isolated from Bedrock Memory rate limits. AgentCore Memory is optimized for agent context injection, not dashboard full-text search, so keeping both in sync decouples UI load from the agent runtime path.

**이중 저장(로컬 + AgentCore).** 로컬 파일 저장소가 대시보드 UI의 정식 소스인 이유는 빠르고(단일 JSON 읽기, 크로스 리전 홉 없음), 예측 가능하며(O(files) 전문 스캔), Bedrock Memory 요청 제한에서 격리되기 때문이다. AgentCore Memory는 에이전트 컨텍스트 주입에 최적화되어 있어 대시보드 전문 검색에는 부적합하다. 둘을 동기화해 UI 부하와 에이전트 런타임 경로를 분리한다.

**Per-user isolation keyed by Cognito identity.** Conversations embed customer-specific resource names, IAM policies, account IDs, and AZ topology. A shared memory pool would cross operational boundaries between teammates and leak context across customer engagements. Cognito JWT (verified upstream by Lambda@Edge) gives a stable `sub` plus `email` claim that `src/lib/auth-utils.ts` extracts without re-verifying the signature.

**Cognito 기반 사용자별 격리.** 대화에는 고객별 리소스 이름, IAM 정책, 계정 ID, AZ 토폴로지가 포함된다. 공유 메모리 풀은 팀원 간 운영 경계와 고객 엔게이지먼트 간 컨텍스트를 넘나들게 한다. Lambda@Edge에서 상위 검증되는 Cognito JWT는 안정적인 `sub`와 `email` 클레임을 제공하고, `src/lib/auth-utils.ts`는 서명을 재검증하지 않고 payload만 디코딩한다.

**365-day retention.** Operational incident patterns repeat quarterly and annually — peak season spikes, quarterly migrations, annual audits. A shorter retention window loses the "we hit this last Q4" recall value. Longer is not supported: AgentCore `eventExpiryDuration` caps at 365 days. Choosing the max is therefore a non-decision constrained by the platform.

**365일 보관.** 운영 인시던트 패턴은 분기·연간 단위로 반복된다(성수기 스파이크, 분기 마이그레이션, 연간 감사). 보관 기간이 짧으면 "지난 Q4에 이런 일이 있었다"는 회상 가치가 사라진다. AgentCore `eventExpiryDuration`은 365일이 상한이므로 최대값 선택은 플랫폼 제약에 따른 것이다.

**Single shared Memory resource (`awsops_memory`).** AgentCore naming forbids hyphens. The resource name is intentionally fixed and not per-user: provisioning 1 resource per user does not scale and conflicts with AgentCore Runtime wiring. Users are namespaced inside the single resource by `userId`.

**단일 공유 Memory 리소스(`awsops_memory`).** AgentCore 이름 규칙은 하이픈을 금지한다. 리소스 이름은 의도적으로 고정되며 사용자별이 아니다. 사용자별 리소스 프로비저닝은 확장성이 없고 AgentCore Runtime 연동과 충돌한다. 단일 리소스 내부에서 `userId`로 네임스페이스를 분리한다.

**Store identity claims, not tokens.** Records carry `userId` (Cognito `sub` or `email`) only. Raw JWTs, session cookies, and AWS credentials are never written to the memory store, keeping the credential surface minimal if the data file is ever exposed.

**토큰이 아닌 신원 클레임 저장.** 기록에는 `userId`(Cognito `sub` 또는 `email`)만 담는다. JWT 원문, 세션 쿠키, AWS 자격증명은 메모리 저장소에 기록하지 않아 데이터 파일이 노출되더라도 자격증명 노출 면적을 최소화한다.

**Local-only keyword search.** `searchConversations()` runs in-process against the cached JSON. AgentCore Memory recall APIs target agent context injection, not dashboard full-text search, and would add latency plus Bedrock throttling risk to every search keystroke.

**로컬 한정 키워드 검색.** `searchConversations()`는 캐시된 JSON에 대해 in-process로 동작한다. AgentCore Memory 회상 API는 에이전트 컨텍스트 주입용이며 대시보드 전문 검색에는 부적합하다. 검색 키 입력마다 지연과 Bedrock 스로틀링 위험이 추가된다.

**Graceful degradation when AgentCore is unavailable.** The setup script explicitly falls back to `MEMORY_ID="local-fallback"` if the region does not support the AgentCore Memory API. The dashboard UI continues to function on the local store; the Strands agent loses prior-session context but still serves the current turn.

**AgentCore 불가 시 우아한 저하.** 해당 리전이 AgentCore Memory API를 지원하지 않으면 설정 스크립트는 명시적으로 `MEMORY_ID="local-fallback"`으로 폴백한다. 대시보드 UI는 로컬 저장소로 계속 동작하고, Strands 에이전트는 이전 세션 컨텍스트를 잃지만 현재 턴은 정상 처리한다.

## Consequences / 결과

### Positive / 긍정적

- Users see only their own history; the agent builds on prior sessions belonging to the same operator.
- Local UI reads are fast and decoupled from Bedrock Memory availability or rate limits.
- 365-day window captures quarterly and annual recurrence patterns that shorter retention would miss.
- Dashboard continues to work even when AgentCore Memory API is unavailable in the target region.

- 사용자는 자신의 이력만 보며, 에이전트는 같은 운영자의 이전 세션 위에 추론을 이어간다.
- 로컬 UI 읽기는 Bedrock Memory 가용성이나 요청 제한과 무관하게 빠르다.
- 365일 창은 짧은 보관으로는 놓칠 분기·연간 반복 패턴을 포착한다.
- 대상 리전에서 AgentCore Memory API가 지원되지 않더라도 대시보드는 동작한다.

### Negative / 부정적

- Dual-storage sync drift is possible: local write can succeed while AgentCore write fails (fire-and-forget semantics are intentional to protect UI latency).
- Per-user namespace means shared team incidents are not auto-correlated across operators. Mitigated by the shared Alert Knowledge Base (ADR-009) which operates at the team level.
- Disk usage grows with users × conversations. `data/memory/` is gitignored and sized into the EC2 host capacity plan; `MAX_CONVERSATIONS=100` and `MAX_SESSIONS=50` caps bound the worst case.
- AgentCore Memory resource name (`awsops_memory`) is fixed; renaming would require Runtime re-wiring.

- 이중 저장 동기화 편차가 발생할 수 있다: 로컬 쓰기는 성공했지만 AgentCore 쓰기는 실패할 수 있다(UI 지연 보호를 위한 fire-and-forget는 의도된 동작).
- 사용자별 네임스페이스로 인해 팀 공유 인시던트는 운영자 간 자동 상관 분석이 되지 않는다. 팀 단위로 동작하는 공유 Alert Knowledge Base(ADR-009)로 완화한다.
- 디스크 사용량은 사용자 × 대화 수에 비례해 증가한다. `data/memory/`는 gitignore 대상이며 EC2 호스트 용량 계획에 반영되었고, `MAX_CONVERSATIONS=100`·`MAX_SESSIONS=50` 상한이 최악 값을 제한한다.
- AgentCore Memory 리소스 이름(`awsops_memory`)은 고정되어 있어 변경 시 Runtime 재연결이 필요하다.

## Security Considerations / 보안 고려 사항

The `userId` field comes from a Cognito-verified JWT. Lambda@Edge in `us-east-1` verifies the token signature and Cognito User Pool membership before the request reaches the ALB; `src/lib/auth-utils.ts` only base64-decodes the payload without re-verifying, so the server-side code never handles secret key material. Memory records never contain the raw JWT, the `awsops_token` cookie value, or AWS credentials — only the `sub`/`email` claim and the conversational content itself. When the user is unauthenticated (for example during local development without Lambda@Edge), `auth-utils.ts` returns a sentinel `ANONYMOUS` identity so records still have a stable `userId` and do not pollute other users' namespaces.

`userId` 필드는 Cognito에서 검증된 JWT에서 추출된다. `us-east-1`의 Lambda@Edge가 ALB 도달 전에 토큰 서명과 Cognito User Pool 소속을 검증하고, `src/lib/auth-utils.ts`는 서명을 재검증하지 않고 payload만 base64 디코딩한다. 서버 측 코드가 비밀 키 재료를 다루지 않는다. Memory 기록에는 JWT 원문, `awsops_token` 쿠키 값, AWS 자격증명이 포함되지 않으며 `sub`/`email` 클레임과 대화 내용만 저장된다. 사용자가 비인증 상태일 때(예: Lambda@Edge가 없는 로컬 개발) `auth-utils.ts`는 센티넬 `ANONYMOUS` 신원을 반환해 다른 사용자의 네임스페이스를 오염시키지 않는다.

Cross-account context (`accountId`) is included in the conversation record so an operator querying account A's memory does not retrieve account B's notes even if the same operator has worked on both accounts. This aligns with the cache-key isolation rule from ADR-008 (multi-account cache keying).

크로스 계정 컨텍스트(`accountId`)가 대화 기록에 포함되어, 동일 운영자가 두 계정에서 작업했더라도 A 계정 메모리 조회 시 B 계정 노트가 반환되지 않는다. ADR-008의 멀티 어카운트 캐시 키 격리 규칙과 일치한다.

## References / 참고

- Source — per-user filtering, fire-and-forget save: `src/lib/agentcore-memory.ts`
- Source — JWT identity extraction: `src/lib/auth-utils.ts`
- Source — AgentCore Memory provisioning (`eventExpiryDuration 365`, `MEMORY_NAME=awsops_memory`): `scripts/06f-setup-agentcore-memory.sh`
- Project context — AgentCore Known Issues (Memory naming, retention cap): root `CLAUDE.md`, section "AgentCore Known Issues" / "AgentCore 알려진 이슈"
- Related — Alert knowledge base (team-level shared incident memory): `docs/decisions/009-alert-triggered-ai-diagnosis.md`
- Related — Multi-account cache-key isolation pattern: `docs/decisions/008-multi-account-support.md`
