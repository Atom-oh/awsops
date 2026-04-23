# ADR-020: Cognito + Lambda@Edge Authentication Architecture / Cognito + Lambda@Edge 인증 아키텍처

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops exposes an operational dashboard that surfaces sensitive AWS account data (IAM, CloudTrail, cost, security posture) and invokes Bedrock/AgentCore on behalf of operators. Unauthenticated access is not acceptable under any deployment model, and anonymous requests must never reach the EC2 instance or consume ALB/Bedrock capacity. The networking topology is CloudFront (global edge) → ALB (regional, CloudFront-only SG) → EC2 (Private Subnet, no public IP). Authentication must therefore terminate at the CloudFront edge and the identity must flow through to every downstream request so that per-user features (AgentCore Memory isolation per ADR-018, department-scoped account filtering per ADR-008, `adminEmails` gate on `/accounts` and `/alert-settings`) can key off a trusted user identifier.

AWSops는 민감한 AWS 계정 데이터(IAM, CloudTrail, 비용, 보안 상태)를 노출하고 운영자를 대신하여 Bedrock/AgentCore를 호출하는 운영 대시보드이다. 어떤 배포 형태에서도 익명 접근은 허용되지 않으며, 인증되지 않은 요청이 EC2 인스턴스나 ALB/Bedrock 용량을 소비하는 일은 없어야 한다. 네트워크 토폴로지는 CloudFront(글로벌 엣지) → ALB(리전, CloudFront 전용 SG) → EC2(Private Subnet, 퍼블릭 IP 없음)이다. 따라서 인증은 CloudFront 엣지에서 종료되어야 하며, 확보된 사용자 식별자는 하위 요청으로 전달되어 사용자별 기능(ADR-018의 AgentCore Memory 격리, ADR-008의 부서별 계정 필터링, `/accounts`·`/alert-settings`의 `adminEmails` 게이트)에 활용되어야 한다.

Three concrete constraints shape the decision. First, EC2 has no public ingress, so any auth check that happens "inside" the app still lets unauthenticated TCP connections consume ALB capacity. Second, CloudFront caching is already `CACHING_DISABLED` (AWS real-time data), so edge-level auth does not trade off cache efficiency. Third, the same user identity must be available to Next.js API routes without the app having to re-verify JWT signatures (which would require distributing Cognito JWKS to the EC2 host and refreshing it on key rotation).

세 가지 제약이 결정을 규정한다. 첫째, EC2는 퍼블릭 인그레스가 없으므로 앱 내부에서 인증을 검사하면 인증 안 된 TCP 연결이 여전히 ALB 용량을 소비한다. 둘째, CloudFront는 이미 `CACHING_DISABLED`(실시간 데이터)이므로 엣지 인증이 캐시 효율성을 해치지 않는다. 셋째, 동일한 사용자 식별자가 Next.js API 라우트에서 JWT 서명을 재검증하지 않고도 사용 가능해야 한다(그렇지 않으면 Cognito JWKS를 EC2로 배포하고 키 로테이션마다 갱신해야 한다).

## Options Considered / 검토한 대안

### Option 1: CloudFront + Cognito + Lambda@Edge (chosen) / CloudFront + Cognito + Lambda@Edge (선택)

A Cognito User Pool hosts identities; a Lambda@Edge function attached to the CloudFront `/awsops*` cache behaviour at the `viewer-request` event validates the `awsops_token` cookie on every request, performs the OAuth2 authorization-code exchange on `/awsops/_callback`, and redirects unauthenticated traffic to an in-app `/awsops/login` page (which in turn uses Cognito `InitiateAuth` via `POST /api/auth`). The issued ID token is stored in an HttpOnly cookie and travels with every subsequent request.

Cognito User Pool이 ID를 관리하고, CloudFront `/awsops*` 캐시 동작의 `viewer-request` 이벤트에 연결된 Lambda@Edge 함수가 매 요청마다 `awsops_token` 쿠키를 검증하며, `/awsops/_callback`에서 OAuth2 authorization-code 교환을 수행하고, 인증되지 않은 트래픽은 앱 내 `/awsops/login` 페이지로 리다이렉트한다(해당 페이지는 다시 `POST /api/auth`를 통해 Cognito `InitiateAuth`를 호출). 발급된 ID 토큰은 HttpOnly 쿠키에 저장되어 이후 모든 요청에 동봉된다.

### Option 2: ALB native Cognito authentication / ALB 네이티브 Cognito 인증

ALB supports a built-in Cognito OIDC listener rule that performs the same OAuth2 dance without any Lambda code. This was rejected for two reasons. The feature requires an HTTPS listener on the ALB, which would force an ACM certificate and DNS ownership proof inside the VPC — AWSops today terminates TLS only at CloudFront and speaks HTTP to ALB. More importantly, ALB auth cannot reject traffic before it hits the ALB: every unauthenticated probe still consumes a target-group connection, and CloudFront (which fronts the ALB globally) would cache or forward the redirects. Edge-level rejection eliminates both classes of load.

ALB는 OAuth2 플로우를 Lambda 코드 없이 수행하는 내장 Cognito OIDC 리스너 규칙을 지원한다. 두 가지 이유로 기각했다. 이 기능은 ALB에 HTTPS 리스너가 필수인데, 이는 VPC 내부에 ACM 인증서와 DNS 소유권 증명을 요구한다 — AWSops는 현재 TLS를 CloudFront에서만 종료하고 ALB에는 HTTP로 통신한다. 더 중요한 것은 ALB 인증이 ALB 앞단에서 트래픽을 거부할 수 없다는 점이다: 인증되지 않은 프로브도 여전히 타겟 그룹 연결을 소비하며, ALB 앞에 있는 CloudFront는 리다이렉트를 캐시하거나 포워딩한다. 엣지 단계 거부가 두 부류의 부하를 모두 제거한다.

### Option 3: Application-level auth in Next.js middleware / Next.js 미들웨어 내 앱 레벨 인증

Next.js 14 middleware can inspect cookies and redirect unauthenticated requests. Rejected because the middleware runs only after CloudFront → ALB → EC2 routing has already happened — the EC2 host pays the CPU cost of every drive-by scan. Additionally, the app would have to own the OAuth2 flow, JWT verification, and JWKS refresh, adding ~300 lines of security-critical code to the Next.js codebase instead of the 100-line Python handler that runs at the edge.

Next.js 14 미들웨어로 쿠키를 검사하고 인증되지 않은 요청을 리다이렉트할 수 있다. 기각 사유는 미들웨어가 CloudFront → ALB → EC2 라우팅이 끝난 뒤에야 실행되어 EC2 호스트가 모든 스캔 트래픽의 CPU 비용을 지불한다는 점이다. 또한 앱이 OAuth2 플로우, JWT 검증, JWKS 갱신을 직접 소유해야 하므로 엣지에서 동작하는 100줄 파이썬 핸들러 대신 ~300줄의 보안 중요 코드가 Next.js 코드베이스에 추가된다.

### Option 4: IAM SigV4 authentication / IAM SigV4 인증

For API-only dashboards, SigV4 with IAM users or SSO can be a fit. Rejected because AWSops is a browser application with a rich UI; SigV4 has no browser-native flow, requires exposing AWS credentials to a SPA (which is unacceptable), and offers no hosted UI / MFA / federation features that Cognito provides out of the box.

API 전용 대시보드라면 IAM 사용자 또는 SSO 기반 SigV4가 적합할 수 있다. 기각 사유는 AWSops가 풍부한 UI를 가진 브라우저 애플리케이션이라는 점이다; SigV4는 브라우저 네이티브 플로우가 없고, SPA에 AWS 자격증명을 노출해야 하며(허용 불가), Cognito가 기본 제공하는 호스티드 UI / MFA / 페더레이션 기능도 없다.

## Decision / 결정

Adopt **Option 1: CloudFront + Cognito + Lambda@Edge**. Deploy a Cognito User Pool plus app client in the primary region (`ap-northeast-2`) and a Python 3.12 Lambda@Edge function in `us-east-1` (the only region Lambda@Edge permits). Attach the Lambda@Edge to the CloudFront `/awsops*` cache behaviour at the `viewer-request` event. Store the Cognito-issued ID token in an `awsops_token` cookie with flags `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`. Inside the Next.js app, `src/lib/auth-utils.ts` decodes the JWT payload without signature verification because Lambda@Edge has already enforced signature validity and expiry upstream.

**Option 1: CloudFront + Cognito + Lambda@Edge**을 채택한다. 주 리전(`ap-northeast-2`)에 Cognito User Pool과 앱 클라이언트를, `us-east-1`(Lambda@Edge가 허용하는 유일한 리전)에 Python 3.12 Lambda@Edge 함수를 배포한다. Lambda@Edge는 CloudFront `/awsops*` 캐시 동작의 `viewer-request` 이벤트에 연결한다. Cognito가 발급한 ID 토큰은 `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600` 플래그로 `awsops_token` 쿠키에 저장한다. Next.js 앱 내부에서 `src/lib/auth-utils.ts`는 Lambda@Edge가 상류에서 서명 유효성과 만료를 이미 강제했으므로 서명 검증 없이 JWT payload만 디코딩한다.

```text
Browser ──HTTPS──► CloudFront (/awsops*)
                       │
                       ▼
              Lambda@Edge viewer-request
              (us-east-1, Python 3.12)
                  │           │
      no cookie / │           │ valid JWT
      expired     │           │
                  ▼           ▼
            302 → /awsops/   forward to ALB
            login                │
                                 ▼
                               ALB → EC2 → Next.js
                                          │
                                          ▼
                               auth-utils.getUserFromRequest()
                               (decode-only, trusts edge)
```

## Rationale / 근거

- **Edge-level rejection protects the origin**: unauthenticated traffic never touches ALB or EC2. CloudFront uses `CACHING_DISABLED` anyway, so there is no cache-coherence tradeoff. / **엣지 단계 거부로 오리진 보호**: 인증되지 않은 트래픽이 ALB·EC2에 도달하지 않는다. CloudFront는 어차피 `CACHING_DISABLED`라서 캐시 일관성 트레이드오프가 없다.
- **Cognito provides identity primitives for free**: hosted UI, password policy (min 8 / upper / lower / digits, symbols intentionally NOT required per the known Cognito onboarding issue documented in `scripts/05-setup-cognito.sh`), MFA, federation, account recovery. Rolling our own auth would re-implement all of this. / **Cognito가 ID 기본 기능을 무상 제공**: 호스티드 UI, 패스워드 정책(최소 8자 / 대소문자 / 숫자, 심볼은 Cognito 온보딩 이슈로 의도적으로 요구하지 않음 — `scripts/05-setup-cognito.sh`에 문서화), MFA, 페더레이션, 계정 복구. 자체 인증을 만들면 이 모두를 재구현해야 한다.
- **Python 3.12 on Lambda@Edge**: chosen over Node because the handler is a short OAuth2 + JWT-exp check (~100 lines) and Python's `base64.urlsafe_b64decode` + `json` are stdlib. The CDK stub in `infra-cdk/lib/cognito-stack.ts` uses `NODEJS_20_X`, but the actual deployed function created by `scripts/05-setup-cognito.sh` uses `python3.12` — the script is authoritative for what runs in production. / **Lambda@Edge Python 3.12**: Node 대신 채택한 이유는 핸들러가 짧은 OAuth2 + JWT exp 검사(~100줄)이고 Python의 `base64.urlsafe_b64decode`·`json`이 표준 라이브러리이기 때문. `infra-cdk/lib/cognito-stack.ts`의 CDK 스텁은 `NODEJS_20_X`를 쓰지만 실제로 배포되는 함수는 `scripts/05-setup-cognito.sh`가 `python3.12`로 생성한다 — 프로덕션 실행 주체는 스크립트이다.
- **`viewer-request` over `origin-request`**: `viewer-request` fires before the CloudFront cache lookup, so unauthenticated users never pull cached HTML. Origin-request would only fire on cache miss. / **`origin-request`가 아닌 `viewer-request`**: `viewer-request`는 CloudFront 캐시 조회 전에 발생하므로 인증되지 않은 사용자가 캐시된 HTML을 받는 일이 없다. origin-request는 캐시 미스에서만 발생한다.
- **HttpOnly cookie over localStorage**: HttpOnly prevents `document.cookie` and XSS-injected scripts from exfiltrating the ID token. SameSite=Lax blocks cross-site POST CSRF. Secure enforces HTTPS-only transmission. / **HttpOnly 쿠키 (localStorage 대신)**: HttpOnly는 `document.cookie`와 XSS 주입 스크립트가 ID 토큰을 탈취하지 못하게 한다. SameSite=Lax는 크로스 사이트 POST CSRF를 차단하고, Secure는 HTTPS 전송만 강제한다.
- **Decode-only in `auth-utils.ts`**: re-verifying the JWT signature at the EC2 host would duplicate the Lambda@Edge check, require distributing Cognito JWKS to the host, and handle key rotation. The trust boundary is deliberately placed at CloudFront: if a request reaches Next.js, the edge has already validated the token. / **`auth-utils.ts`는 디코드만 수행**: EC2 호스트에서 JWT 서명을 재검증하면 Lambda@Edge 검사가 중복되고 Cognito JWKS를 호스트로 배포·회전해야 한다. 신뢰 경계는 의도적으로 CloudFront에 두었다: Next.js에 도달한 요청은 이미 엣지에서 토큰이 검증된 것이다.
- **Server-side logout via `POST /api/auth`**: HttpOnly cookies cannot be cleared by `document.cookie` in the browser. A POST endpoint returns `Set-Cookie: awsops_token=; ...; Max-Age=0`, which is the only way to invalidate the session from the UI. / **`POST /api/auth`를 통한 서버 사이드 로그아웃**: HttpOnly 쿠키는 브라우저에서 `document.cookie`로 삭제할 수 없다. POST 엔드포인트가 `Set-Cookie: awsops_token=; ...; Max-Age=0`을 반환하며, 이것이 UI에서 세션을 무효화하는 유일한 방법이다.

## Security Considerations / 보안 고려 사항

- **Cookie hardening**: `awsops_token` is set with `Secure; HttpOnly; SameSite=Lax; Max-Age=3600` by both Lambda@Edge (`scripts/05-setup-cognito.sh` line 293) and the in-app login handler (`src/app/api/auth/route.ts` line 83). The 1-hour lifetime matches Cognito's `idTokenValidity` to avoid zombie sessions. / **쿠키 강화**: `awsops_token`은 Lambda@Edge(`scripts/05-setup-cognito.sh` 293행)와 앱 내 로그인 핸들러(`src/app/api/auth/route.ts` 83행) 양쪽에서 `Secure; HttpOnly; SameSite=Lax; Max-Age=3600`으로 설정된다. 1시간 수명은 Cognito `idTokenValidity`와 일치시켜 좀비 세션을 방지한다.
- **JWT validation happens once, at the edge**: signature + issuer + audience + exp are checked by Lambda@Edge. The app-side decode in `auth-utils.ts` is explicitly commented as "already verified by Lambda@Edge". / **JWT 검증은 엣지에서 한 번만 수행**: 서명·issuer·audience·exp가 Lambda@Edge에서 검사된다. `auth-utils.ts`의 앱 사이드 디코드에는 "already verified by Lambda@Edge" 주석이 명시되어 있다.
- **No refresh-token storage in the browser**: only the ID token (1h TTL) is stored client-side. Cognito refresh tokens (30d TTL) never leave the Cognito/Lambda@Edge boundary. / **브라우저에 refresh token 저장 없음**: ID 토큰(1시간 TTL)만 클라이언트에 저장된다. Cognito refresh 토큰(30일 TTL)은 Cognito/Lambda@Edge 경계를 벗어나지 않는다.
- **Least-privilege Lambda@Edge role**: `AWSopsLambdaEdgeRole` receives only `AWSLambdaBasicExecutionRole`. No AWS API calls beyond CloudWatch Logs; the OAuth2 code exchange is a plain HTTPS call to the Cognito domain, not an AWS SDK call. / **Lambda@Edge 최소 권한 역할**: `AWSopsLambdaEdgeRole`은 `AWSLambdaBasicExecutionRole`만 부여받는다. CloudWatch Logs 외 AWS API 호출 없음; OAuth2 코드 교환은 Cognito 도메인으로의 순수 HTTPS 호출이며 AWS SDK 호출이 아니다.
- **Password policy in Cognito**: min length 8, requires uppercase + lowercase + digits. Symbols are NOT required due to a documented Cognito onboarding quirk (admin-set-password fails with `RequireSymbols=true` on some paths) — tracked in `docs/TROUBLESHOOTING.md` §10. / **Cognito 패스워드 정책**: 최소 길이 8, 대·소문자·숫자 요구. 심볼은 문서화된 Cognito 온보딩 이슈(일부 경로에서 `RequireSymbols=true`일 때 admin-set-password 실패)로 요구하지 않음 — `docs/TROUBLESHOOTING.md` §10 참조.
- **Identity flows to downstream features**: the `sub` / `email` / `cognito:groups` claims decoded by `auth-utils.ts` drive AgentCore Memory isolation (ADR-018), department-based account visibility (ADR-008), and admin-only pages. A spoofed or replayed cookie would bypass all three; hence the strict edge verification. / **식별자가 하위 기능으로 전파**: `auth-utils.ts`가 디코드한 `sub` / `email` / `cognito:groups` 클레임은 AgentCore Memory 격리(ADR-018), 부서별 계정 가시성(ADR-008), admin 전용 페이지의 기반이 된다. 위조·재전송된 쿠키는 세 가지 모두를 우회할 수 있으므로 엣지 검증이 엄격하다.

## Consequences / 결과

### Positive / 긍정적

- CloudFront rejects unauthenticated traffic globally before it can reach ALB or EC2, removing an entire class of load and probe attacks. / CloudFront가 인증되지 않은 트래픽을 ALB·EC2에 도달하기 전에 전역적으로 거부하여 부하 및 프로브 공격의 한 부류 전체를 제거한다.
- Cognito provides hosted UI, MFA readiness, federation hooks, and password policy enforcement without custom code. / Cognito가 호스티드 UI, MFA 준비, 페더레이션 훅, 패스워드 정책 강제를 커스텀 코드 없이 제공한다.
- HttpOnly + Secure + SameSite=Lax cookies make the ID token inaccessible to JavaScript and resistant to CSRF. / HttpOnly + Secure + SameSite=Lax 쿠키가 ID 토큰을 JavaScript에서 접근 불가능하게 하고 CSRF에 저항한다.
- Decode-only in `auth-utils.ts` saves per-request CPU and eliminates the need to distribute Cognito JWKS to EC2. / `auth-utils.ts`의 디코드 전용 정책이 요청당 CPU를 절약하고 Cognito JWKS를 EC2로 배포할 필요를 제거한다.
- Identity propagates uniformly into ADR-008 (multi-account filtering) and ADR-018 (memory isolation) without additional plumbing. / 식별자가 ADR-008(멀티 어카운트 필터링)·ADR-018(메모리 격리)로 추가 배선 없이 균일하게 전파된다.

### Negative / 부정적

- Lambda@Edge is region-locked to `us-east-1`, forcing a two-region CDK deployment (`AwsopsStack` in the primary region, `CognitoStack` in us-east-1). Cross-stack coordination is handled by `scripts/05-setup-cognito.sh` and `scripts/08-setup-cloudfront-auth.sh`. / Lambda@Edge가 `us-east-1` 리전에 고정되어 있어 두 리전 CDK 배포를 강제한다(`AwsopsStack`은 주 리전, `CognitoStack`은 us-east-1). 스택 간 조율은 `scripts/05-setup-cognito.sh`·`scripts/08-setup-cloudfront-auth.sh`가 담당한다.
- Lambda@Edge cold starts add roughly 100–300ms to the first request in each edge location. Mitigated by the 128 MB / 5 s runtime footprint and the fact that auth is a one-shot per session. / Lambda@Edge 콜드 스타트가 엣지 로케이션당 첫 요청에 약 100-300ms를 더한다. 128 MB / 5초 런타임 풋프린트와 세션당 한 번만 인증된다는 점으로 완화한다.
- Debugging auth failures requires reading CloudFront real-time logs or Lambda@Edge CloudWatch Logs in the executing region (not us-east-1) — local app logs show nothing because the app never sees the rejected request. / 인증 실패 디버깅에는 CloudFront 실시간 로그나 실행 리전(us-east-1 아님)의 Lambda@Edge CloudWatch Logs를 읽어야 한다 — 거부된 요청은 앱에 도달하지 않으므로 로컬 앱 로그에는 아무것도 남지 않는다.
- Logout requires a POST (`fetch('/awsops/api/auth', { method: 'POST' })`) instead of a plain link, because HttpOnly cookies cannot be cleared from `document.cookie`. The UX is a minor "Sign Out" button behaviour change. / HttpOnly 쿠키는 `document.cookie`로 삭제할 수 없으므로 로그아웃은 단순 링크가 아닌 POST(`fetch('/awsops/api/auth', { method: 'POST' })`)가 필요하다. UX 측면에서는 "Sign Out" 버튼 동작의 작은 변경이다.
- CDK source (`infra-cdk/lib/cognito-stack.ts`) contains a Node.js Lambda@Edge stub that does not match the production Python 3.12 handler created by `scripts/05-setup-cognito.sh`. This drift is tolerated today because the script is authoritative, but should be reconciled in a future revision. / CDK 소스(`infra-cdk/lib/cognito-stack.ts`)는 `scripts/05-setup-cognito.sh`가 생성하는 프로덕션 Python 3.12 핸들러와 일치하지 않는 Node.js Lambda@Edge 스텁을 포함한다. 현재는 스크립트가 실행 주체이므로 용인되지만 차후 리비전에서 정리해야 한다.

## References / 참고 자료

### Internal / 내부
- `infra-cdk/lib/cognito-stack.ts` — CDK construct for User Pool, app client, hosted UI domain, Lambda@Edge role, and outputs (cross-stack exports consumed by the setup scripts).
- `src/lib/auth-utils.ts` — `getUserFromRequest()` decode-only implementation. Trust boundary note on line 1-4.
- `src/app/api/auth/route.ts` — `POST /api/auth` handler for login (Cognito `InitiateAuth`) and logout (cookie clear with `Max-Age=0`).
- `scripts/05-setup-cognito.sh` — Authoritative provisioning: creates User Pool, domain, app client, admin user, and deploys the Python 3.12 Lambda@Edge in `us-east-1` (line 321).
- `scripts/08-setup-cloudfront-auth.sh` — Attaches the published Lambda@Edge version to the CloudFront `/awsops*` behaviour at `viewer-request`.
- Root `CLAUDE.md` "Auth" line: `Cognito User Pool + Lambda@Edge (Python 3.12, us-east-1) + CloudFront`.
- [ADR-008](008-multi-account-support.md): Multi-account support — user identity decoded here gates department-based account filtering.
- [ADR-018](018-agentcore-memory-isolation-retention.md): AgentCore Memory isolation — uses the `sub` claim from this cookie for per-user session separation.

### External / 외부
- [Amazon Cognito User Pools — OAuth 2.0 endpoints](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-userpools-server-contract-reference.html)
- [Lambda@Edge — viewer-request event](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-the-edge.html)
- [OWASP — HttpOnly cookie flag](https://owasp.org/www-community/HttpOnly)
- [RFC 6749 — OAuth 2.0 Authorization Code Grant](https://datatracker.ietf.org/doc/html/rfc6749#section-4.1)
