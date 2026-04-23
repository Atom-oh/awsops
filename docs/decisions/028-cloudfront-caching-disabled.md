# ADR-028: CloudFront CachePolicy CACHING_DISABLED / CloudFront 캐시 정책 CACHING_DISABLED

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops fronts its Next.js dashboard with Amazon CloudFront, but the distribution's default cache policy is intentionally set to `CachePolicy.CACHING_DISABLED`. On the surface this looks contradictory — CloudFront is, first and foremost, a content delivery cache — so the choice requires explicit justification. The dashboard's primary payload is live AWS state: EC2 inventories, current Cost Explorer snapshots, running Kubernetes pods, in-flight CIS findings, and AgentCore-driven diagnoses. A user who deploys a new resource and refreshes the page expects to see it immediately; a user resolving an incident must never look at a cached snapshot of a failed service. Beyond correctness, AWSops already runs a Lambda@Edge (`viewer-request`) authenticator (ADR-020) that must execute on every request, and the app-side caching layer (`node-cache` with 5-minute TTL and background prewarming per ADR-017) is already tuned to the exact freshness/latency trade-offs the dashboard needs.

AWSops는 Amazon CloudFront를 통해 Next.js 대시보드를 서비스하지만, 디스트리뷰션의 기본 캐시 정책은 의도적으로 `CachePolicy.CACHING_DISABLED`로 설정되어 있다. 표면적으로 보면 CloudFront의 일차 목적이 콘텐츠 전송 캐시이므로 모순처럼 보이며, 따라서 이 선택은 명시적인 근거가 필요하다. 대시보드의 주 페이로드는 실시간 AWS 상태이다: EC2 인벤토리, 현재 Cost Explorer 스냅샷, 실행 중인 Kubernetes 파드, 진행 중인 CIS 결과, AgentCore 기반 진단. 새 리소스를 배포한 사용자가 페이지를 새로고침하면 즉시 확인할 수 있어야 하며, 장애를 해결 중인 사용자는 실패한 서비스의 캐시된 스냅샷을 절대 봐선 안 된다. 정확성 외에도, AWSops는 이미 매 요청마다 실행되어야 하는 Lambda@Edge(`viewer-request`) 인증기(ADR-020)를 운영하며, 앱 레벨 캐시 레이어(`node-cache`, 5분 TTL, ADR-017의 백그라운드 프리워밍)는 대시보드가 필요로 하는 신선도/지연 트레이드오프에 이미 최적화되어 있다.

The question this ADR answers is therefore narrower than "should we use CloudFront": CloudFront is already required for edge auth, global TLS termination, AWS Shield Standard DDoS protection, and the CloudFront-prefix-list SG that fronts the ALB. The real question is "given that CloudFront is in the request path anyway, what cache policy should it enforce?".

따라서 이 ADR이 답하는 질문은 "CloudFront를 쓸 것인가"보다 좁다: CloudFront는 엣지 인증, 글로벌 TLS 종료, AWS Shield Standard DDoS 방어, ALB 앞단의 CloudFront prefix-list SG를 위해 이미 필수이다. 실제 질문은 "이미 요청 경로에 CloudFront가 있다면 어떤 캐시 정책을 적용할 것인가"이다.

## Options Considered / 검토한 대안

### Option 1: `CachePolicy.CACHING_DISABLED` on all dashboard behaviours (chosen) / 대시보드 동작 전반에 `CachePolicy.CACHING_DISABLED` (선택)

Apply `cloudfront.CachePolicy.CACHING_DISABLED` to the default behaviour and to the `/awsops*` cache behaviour, while keeping `CACHING_OPTIMIZED` only for the `/awsops/_next/*` static assets path (content-hashed URLs). Every API and every HTML response is forwarded to the ALB origin with no edge caching; the Lambda@Edge auth check runs on each request, and freshness is delivered by the app's in-process `node-cache`.

기본 동작과 `/awsops*` 캐시 동작에는 `cloudfront.CachePolicy.CACHING_DISABLED`를 적용하고, `/awsops/_next/*` 정적 자산 경로(콘텐츠 해시 URL)만 `CACHING_OPTIMIZED`를 유지한다. 모든 API와 HTML 응답은 엣지 캐싱 없이 ALB 오리진으로 전달되며, Lambda@Edge 인증은 매 요청마다 실행되고, 신선도는 앱 내 `node-cache`가 담당한다.

### Option 2: `CACHING_OPTIMIZED` with per-response `no-cache` headers on dynamic routes / 동적 라우트에 `no-cache` 헤더를 설정하고 `CACHING_OPTIMIZED` 사용

Use `CACHING_OPTIMIZED` globally and rely on each API/page handler to return `Cache-Control: no-store, no-cache` for anything dynamic. This was rejected as unsafe. A single handler that forgets the header — or a new developer unaware of the convention — would leak live AWS state into the CloudFront cache, where it would be served to the wrong user (cache keys default to method + path + normalized headers) for up to the default TTL. The failure mode is silent and security-sensitive; the mitigation is policy-level enforcement rather than per-response discipline.

`CACHING_OPTIMIZED`를 전역 적용하고 각 API/페이지 핸들러가 동적 응답에 `Cache-Control: no-store, no-cache`를 반환하도록 위임한다. 안전하지 않아 기각했다. 헤더를 빠뜨린 핸들러 하나 또는 규약을 모르는 신규 개발자 하나만으로 실시간 AWS 상태가 CloudFront 캐시에 유입되어 기본 TTL 동안 엉뚱한 사용자에게(캐시 키는 메서드 + 경로 + 정규화 헤더가 기본) 제공된다. 실패 모드는 조용하고 보안 민감하며, 완화책은 응답별 규율이 아닌 정책 레벨 강제여야 한다.

### Option 3: Per-path cache policy (static assets cached, API not cached) / 경로별 캐시 정책 (정적 자산만 캐싱, API 미캐싱)

Split behaviours: `/awsops/_next/*` → `CACHING_OPTIMIZED` (already applied), `/awsops/api/*` → `CACHING_DISABLED`, `/awsops/*` → short TTL. This was partially adopted — the `/awsops/_next/*` carve-out does exist in `infra-cdk/lib/awsops-stack.ts` for Next.js content-hashed assets — but extending the split to page HTML was rejected. Next.js standalone mode already emits `Cache-Control: no-store` on dashboard pages because every page is a server-rendered view over live Steampipe data, so adding a short CloudFront TTL would only create opportunities for stale HTML without delivering hit-rate benefit. The static-asset carve-out survives because those URLs are immutable (content-hashed) and therefore cannot go stale.

동작을 분리한다: `/awsops/_next/*` → `CACHING_OPTIMIZED`(이미 적용), `/awsops/api/*` → `CACHING_DISABLED`, `/awsops/*` → 짧은 TTL. 일부만 채택되었다 — `/awsops/_next/*` 예외는 Next.js 콘텐츠 해시 자산을 위해 `infra-cdk/lib/awsops-stack.ts`에 이미 존재한다 — 그러나 페이지 HTML로 분할을 확장하는 것은 기각했다. Next.js standalone 모드는 모든 페이지가 실시간 Steampipe 데이터를 서버 렌더링하므로 이미 `Cache-Control: no-store`를 내보내며, CloudFront에 짧은 TTL을 더해도 히트율 이득 없이 HTML 상태만 불안해진다. 정적 자산 예외가 유지되는 이유는 그 URL들이 불변(콘텐츠 해시)이어서 절대 낡지 않기 때문이다.

### Option 4: Skip CloudFront entirely; ALB + ACM directly / CloudFront 제거, ALB + ACM 직결

If caching is off, arguably CloudFront adds nothing. Rejected because CloudFront carries four non-cache roles AWSops depends on: (1) Lambda@Edge `viewer-request` attachment for pre-origin auth (ADR-020), (2) global TLS termination with an ACM cert in `us-east-1` required by Lambda@Edge, (3) AWS Shield Standard and a consistent global ingress surface, and (4) the `com.amazonaws.global.cloudfront.origin-facing` prefix list that the ALB security group uses as its sole ingress source. Removing CloudFront would force ALB to carry a public HTTPS listener, re-provision certs in the VPC region, host auth inside the application (ruled out in ADR-020), and open the ALB SG to `0.0.0.0/0`.

캐싱을 끈다면 CloudFront가 무의미하다는 주장이 가능하다. 기각한 이유는 CloudFront가 AWSops가 의존하는 네 가지 비-캐시 역할을 수행하기 때문이다: (1) ADR-020의 오리진 도달 전 인증을 위한 Lambda@Edge `viewer-request` 연결, (2) Lambda@Edge가 요구하는 `us-east-1` ACM 인증서로 글로벌 TLS 종료, (3) AWS Shield Standard와 일관된 글로벌 인그레스 표면, (4) ALB 보안 그룹이 유일한 인그레스 소스로 사용하는 `com.amazonaws.global.cloudfront.origin-facing` prefix list. CloudFront 제거 시 ALB가 퍼블릭 HTTPS 리스너를 안고, VPC 리전에 인증서를 재발급하며, 인증을 애플리케이션에 내장해야 하고(ADR-020에서 기각됨), ALB SG를 `0.0.0.0/0`으로 열어야 한다.

## Decision / 결정

Adopt **Option 1**. In `infra-cdk/lib/awsops-stack.ts` declare a single `noCachePolicy` and apply it to both the default behaviour and the `/awsops*` behaviour; keep `CACHING_OPTIMIZED` only on `/awsops/_next/*` for immutable hashed assets.

**Option 1**을 채택한다. `infra-cdk/lib/awsops-stack.ts`에서 `noCachePolicy` 하나를 선언하고 기본 동작과 `/awsops*` 동작에 동일하게 적용한다; `CACHING_OPTIMIZED`는 불변 해시 자산을 위한 `/awsops/_next/*`에만 유지한다.

```typescript
// infra-cdk/lib/awsops-stack.ts
const noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;

this.distribution = new cloudfront.Distribution(this, 'CloudFrontDistribution', {
  defaultBehavior: {
    origin: albOriginVSCode,
    cachePolicy: noCachePolicy,
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
  },
  additionalBehaviors: {
    '/awsops*':        { cachePolicy: noCachePolicy, /* ... */ },
    '/awsops/_next/*': { cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, /* ... */ },
  },
});
```

The Lambda@Edge auth function (ADR-020) is attached to the `/awsops*` behaviour at the `viewer-request` event by `scripts/08-setup-cloudfront-auth.sh`, which only works correctly when the edge fires on every request — another reason to keep CACHING_DISABLED rather than letting CloudFront short-circuit on cache hits.

Lambda@Edge 인증 함수(ADR-020)는 `scripts/08-setup-cloudfront-auth.sh`에 의해 `/awsops*` 동작의 `viewer-request` 이벤트에 연결되며, 이 인증은 엣지가 매 요청마다 발화해야 정상 동작한다 — CloudFront가 캐시 히트로 단락되는 것을 막기 위해 CACHING_DISABLED를 유지하는 또 하나의 이유이다.

## Rationale / 근거

- **Correctness beats hit rate**: the dashboard's value proposition is "what does AWS look like *right now*"; any non-zero TTL breaks that promise. / **정확성이 히트율보다 우선**: 대시보드의 핵심 가치는 "AWS가 *지금 이 순간* 어떤 상태인가"이며, 0이 아닌 TTL은 이 약속을 깨뜨린다.
- **Policy-level enforcement over per-response discipline**: `CACHING_DISABLED` removes the class of bugs where a handler forgets `Cache-Control: no-store` and leaks live data into the shared CloudFront cache. / **응답별 규율보다 정책 레벨 강제**: `CACHING_DISABLED`는 핸들러가 `Cache-Control: no-store`를 빠뜨려 실시간 데이터를 공용 CloudFront 캐시에 유출하는 버그 부류를 제거한다.
- **App-level caching is already optimal**: ADR-017's `node-cache` (5-minute TTL, prewarmed every 4 minutes) sits inside the Next.js process with full knowledge of per-account scoping and cache-key prefixing. CloudFront cannot match that granularity and would only degrade correctness. / **앱 레벨 캐싱이 이미 최적**: ADR-017의 `node-cache`(5분 TTL, 4분 주기 프리워밍)는 Next.js 프로세스 내부에서 계정별 스코핑과 캐시 키 접두사를 완전히 인지하며 동작한다. CloudFront는 이 세분도를 흉내낼 수 없고 정확성만 떨어뜨린다.
- **Lambda@Edge must run on every request**: ADR-020 relies on `viewer-request` firing before the cache lookup; CACHING_DISABLED aligns with that contract and guarantees no request bypasses the edge auth via a cache hit. / **Lambda@Edge는 매 요청 실행 필요**: ADR-020은 `viewer-request`가 캐시 조회 전에 발화하는 것을 전제로 한다; CACHING_DISABLED는 이 계약과 부합하며 캐시 히트로 엣지 인증이 우회되지 않음을 보장한다.
- **Static assets already solved**: Next.js emits content-hashed URLs under `/_next/`, so the browser caches them indefinitely (`immutable` + long `max-age`). The `CACHING_OPTIMIZED` carve-out on `/awsops/_next/*` lets CloudFront serve these cheaply; no further CDN caching is needed. / **정적 자산은 이미 해결**: Next.js는 `/_next/` 아래 콘텐츠 해시 URL을 내보내므로 브라우저가 영구 캐싱(`immutable` + 긴 `max-age`)한다. `/awsops/_next/*`의 `CACHING_OPTIMIZED` 예외로 CloudFront가 이 자산들을 저렴하게 제공하며, 추가 CDN 캐싱은 불필요하다.
- **Small, trusted audience**: AWSops serves an internal ops team (< 100 concurrent users) from a t4g.2xlarge EC2. Origin load from uncached traffic is within capacity; the cost/benefit of edge caching is near-zero at this scale. / **소규모 신뢰 사용자층**: AWSops는 t4g.2xlarge EC2에서 내부 운영팀(동시 접속 < 100)에게 서비스된다. 캐시되지 않은 트래픽의 오리진 부하는 용량 내이며, 이 규모에서 엣지 캐싱의 비용/편익은 0에 가깝다.

## Consequences / 결과

### Positive / 긍정적

- Zero risk of a stale dashboard: every page load reflects the latest AWS state as materialized by Steampipe and `node-cache`. / 대시보드 상태가 낡을 위험 전무: 매 페이지 로드가 Steampipe와 `node-cache`가 구현한 최신 AWS 상태를 반영한다.
- Simplest possible cache policy — one `noCachePolicy` constant drives both dynamic behaviours; no per-route TTL matrix to maintain. / 가능한 가장 단순한 캐시 정책 — `noCachePolicy` 상수 하나가 두 동적 동작을 모두 구동하며, 경로별 TTL 매트릭스를 유지할 필요가 없다.
- Lambda@Edge auth executes on 100% of requests; no cache-hit path can bypass the `viewer-request` check. / Lambda@Edge 인증이 요청의 100%에서 실행되며, 캐시 히트 경로로 `viewer-request` 검사가 우회될 수 없다.
- CloudFront still delivers TLS termination, AWS Shield Standard, CloudFront-origin-facing SG enforcement, and the Lambda@Edge attachment point without the operational overhead of cache invalidation, distribution-wide TTL tuning, or `CreateInvalidation` API calls on deploy. / CloudFront는 여전히 TLS 종료, AWS Shield Standard, CloudFront-origin-facing SG 강제, Lambda@Edge 연결을 제공하며 캐시 무효화·디스트리뷰션 TTL 튜닝·배포 시 `CreateInvalidation` API 호출의 운영 부담은 없다.

### Negative / 부정적

- Origin load is not reduced by CloudFront; every request reaches ALB → EC2. Capacity planning must size the EC2 host for full peak traffic, not a cached fraction. / CloudFront가 오리진 부하를 낮춰주지 않는다; 모든 요청이 ALB → EC2에 도달한다. 용량 산정 시 캐시된 일부가 아닌 전체 피크 트래픽을 기준으로 EC2 호스트를 크기해야 한다.
- For users geographically distant from the EC2 origin (`ap-northeast-2`), latency is the full RTT plus Lambda@Edge cold-start; a cached edge response would have been faster. / EC2 오리진(`ap-northeast-2`)에서 지리적으로 먼 사용자는 전체 RTT + Lambda@Edge 콜드 스타트만큼 지연을 겪는다; 엣지에서 캐시 응답이 가능했다면 더 빨랐을 것이다.
- CloudFront bandwidth out costs are not offset by cache hits, since every byte is fetched from the origin per request. At current scale this is negligible, but scaling to hundreds of concurrent users would warrant revisiting. / CloudFront outbound 대역폭 비용이 캐시 히트로 상쇄되지 않는다. 매 바이트가 요청마다 오리진에서 가져와지기 때문이다. 현재 규모에서는 무시할 수준이지만 동시 사용자가 수백 명 규모로 커지면 재검토가 필요하다.
- Developers migrating from typical CDN-backed apps must remember that no CloudFront-level caching exists; any performance concern must be solved in `node-cache` or the query layer, not by tweaking CloudFront TTLs. / 일반적인 CDN 기반 앱 경험이 있는 개발자는 CloudFront 레벨 캐싱이 없다는 점을 숙지해야 한다; 성능 이슈는 CloudFront TTL 조정이 아니라 `node-cache`나 쿼리 레이어에서 해결해야 한다.

## References / 참고 자료

### Internal / 내부
- `infra-cdk/lib/awsops-stack.ts` lines 666–727 — `noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED`, applied to default behaviour and `/awsops*`; `/awsops/_next/*` uses `CACHING_OPTIMIZED`.
- `infra-cdk/CLAUDE.md` — "CachePolicy는 **CACHING_DISABLED** — AWS 실시간 데이터를 캐싱하지 않음" / "CloudFront uses `CACHING_DISABLED` since AWS data is real-time."
- Root `CLAUDE.md` Architecture section — "CloudFront (CACHING_DISABLED) → ALB → EC2 (t4g.2xlarge, Private Subnet)".
- `scripts/08-setup-cloudfront-auth.sh` — attaches Lambda@Edge at `viewer-request` on the `/awsops*` behaviour; relies on cache-disabled edge firing on every request.
- [ADR-017](017-cache-warmer-prewarming-strategy.md): Cache Warmer Prewarming Strategy — the in-app `node-cache` layer that replaces CDN caching with per-account, per-query control.
- [ADR-020](020-cognito-lambda-edge-auth.md): Cognito + Lambda@Edge Authentication — requires `viewer-request` on every request, reinforcing CACHING_DISABLED.

### External / 외부
- [AWS Managed Cache Policies — CachingDisabled](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-caching-disabled)
- [Lambda@Edge — viewer-request event ordering](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-the-edge.html)
- [CloudFront origin request policy ALL_VIEWER](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html)
