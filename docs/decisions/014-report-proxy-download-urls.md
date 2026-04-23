# ADR-014: Report Delivery via Proxy URLs / 프록시 URL을 통한 리포트 다운로드

## Status: Accepted (2026-04-22) / 상태: 채택됨

## Context / 컨텍스트

The AI Diagnosis feature generates 15-section reports as DOCX, Markdown, and PDF artifacts that persist to S3 (`reportBucket` in `data/config.json`). The original download flow linked the browser directly to S3 presigned URLs returned from `POST /api/report`. This worked for the common case of "generate and immediately download," but surfaced three recurring problems in production. First, presigned URLs baked from STS-derived EC2 Instance Role credentials expire when the STS session rotates (around 6 hours, earlier than the nominal `X-Amz-Expires=7d`); a user who generates a report in the morning and returns after lunch sees the download buttons return HTTP 403. Second, the URLs are shareable by anyone who obtains them during the validity window, bypassing the Cognito session protecting the dashboard -- a user who pastes a download URL into Slack effectively grants anonymous access to a potentially sensitive diagnosis artifact. Third, they cannot be revoked mid-flight when a user session is invalidated (for example, after role changes or a forced sign-out), leaving signed S3 links valid until their signature expires.

AI 진단 기능은 15섹션 리포트를 DOCX, Markdown, PDF 형식으로 생성하여 S3(`data/config.json`의 `reportBucket`)에 저장한다. 기존 다운로드 흐름은 `POST /api/report`가 반환한 S3 presigned URL로 브라우저가 직접 접근하는 방식이었다. "생성 즉시 다운로드" 시나리오에서는 문제가 없었지만, 운영 환경에서 세 가지 문제가 반복해서 발생했다. 첫째, EC2 Instance Role 기반 STS 자격 증명으로 서명한 presigned URL은 STS 세션이 갱신될 때(보통 6시간, `X-Amz-Expires=7d`보다 훨씬 빨리) 만료된다 -- 오전에 리포트를 생성하고 점심 식사 후 복귀한 사용자는 다운로드 버튼에서 HTTP 403을 받는다. 둘째, 유효 기간 내에는 URL을 획득한 누구나 접근 가능하여 대시보드를 보호하는 Cognito 세션을 우회한다 -- Slack에 다운로드 URL을 붙여 넣는 것은 사실상 익명 접근을 허용하는 셈이 된다. 셋째, 한 번 발급된 presigned URL은 사용자 세션이 무효화되어도(권한 변경, 강제 로그아웃 등) 철회할 수 없으며 서명 만료까지 유효하게 남는다.

This ADR was prompted by commit `887e5b8` ("fix: use proxy URLs for report downloads instead of raw presigned URLs") which landed the fix for the DOCX/MD/PDF download buttons in `src/app/ai-diagnosis/page.tsx`. The scope of the decision is broader than that single commit: it codifies the pattern for every future S3-backed download in AWSops.

이 ADR은 커밋 `887e5b8`("fix: use proxy URLs for report downloads instead of raw presigned URLs")이 `src/app/ai-diagnosis/page.tsx`의 DOCX/MD/PDF 다운로드 버튼 수정을 도입하면서 작성되었다. 결정의 범위는 해당 커밋을 넘어 AWSops의 모든 향후 S3 기반 다운로드에 적용되는 패턴을 정립한다.

## Decision / 결정

All report downloads now flow through an AWSops-hosted proxy endpoint instead of linking the browser directly to S3. The UI buttons in `src/app/ai-diagnosis/page.tsx` point at `/awsops/api/report?id=<reportId>&action=download-docx|download-md|download-pdf`. On each request, `src/app/api/report/route.ts` authenticates the caller via the existing Cognito session cookie, fetches the corresponding object from the `reportBucket` using the EC2 Instance Role, and streams the bytes back to the browser with `Content-Disposition: attachment`. Presigned URLs are no longer exposed to the client at all. The `downloadUrlDocx` / `downloadUrlMd` / `downloadUrlPdf` state variables were removed from the page, eliminating the stale-URL failure mode entirely.

이제 모든 리포트 다운로드는 S3로 직접 연결하는 대신 AWSops가 호스팅하는 프록시 엔드포인트를 경유한다. `src/app/ai-diagnosis/page.tsx`의 UI 버튼은 `/awsops/api/report?id=<reportId>&action=download-docx|download-md|download-pdf`를 가리킨다. `src/app/api/report/route.ts`는 요청마다 기존 Cognito 세션 쿠키로 인증을 수행하고, EC2 Instance Role을 사용해 `reportBucket`에서 해당 객체를 조회한 뒤 `Content-Disposition: attachment` 헤더와 함께 바이트를 스트리밍한다. Presigned URL은 더 이상 클라이언트에 노출되지 않으며, 페이지에서 `downloadUrlDocx` / `downloadUrlMd` / `downloadUrlPdf` 상태 변수를 제거하여 URL 만료 실패 모드를 원천적으로 제거했다.

Request flow / 요청 흐름:

```text
Browser                CloudFront            Next.js / API         S3
   │                       │                       │                │
   ├── GET /awsops/api/report?id=R&action=download-docx ─────────►  │
   │                       │ Lambda@Edge           │                │
   │                       │ (Cognito auth)        │                │
   │                       ├──────────────────────►│                │
   │                       │                       │ auth-utils.ts  │
   │                       │                       │ verifies JWT   │
   │                       │                       ├── s3:GetObject ►│
   │                       │                       │◄── object body ─┤
   │                       │◄── stream + attachment header ──────────┤
   │◄── file download ─────┤                       │                │
```

## Rationale / 근거

- **Session-aligned lifetime**: Proxy URLs are valid as long as the user's Cognito session is valid. Lambda@Edge already refreshes that session on each navigation, so the URL never goes stale while the user is logged in. Presigned URLs are tied to the STS credentials active at signing time, which the EC2 role rotates independently of user sessions.
- **Access control parity**: Every download path now enforces the same authentication as every other dashboard route. A user who forwards a download URL to a colleague without dashboard access gets a 401 at the CloudFront / Lambda@Edge layer rather than silently leaking a signed S3 link.
- **Revocability**: Invalidating a user session immediately stops their downloads. Presigned URLs signed during that session would otherwise remain valid for the full `X-Amz-Expires` window with no recall mechanism.
- **Audit consistency**: Proxy requests land in Next.js access logs correlated with the authenticated user (via `src/lib/auth-utils.ts`). Presigned URL fetches appear only in CloudTrail / S3 access logs under the EC2 Instance Role, with no user attribution.
- **Uniform pattern**: The same pattern should now apply to every S3-backed downloadable artifact in AWSops (report exports today, potentially inventory snapshots, cost exports, diagnosis archives later). Standardizing on proxy URLs avoids per-feature decisions about URL expiry.

세션 수명 정렬, 대시보드와 동일한 접근 제어, 즉시 철회 가능성, 사용자 단위 감사 추적, 그리고 향후 S3 기반 다운로드 자산(리포트, 인벤토리 스냅샷, 비용 export 등) 전반에 적용할 수 있는 일관된 패턴을 확보하기 위한 결정이다.

## Consequences / 결과

### Positive / 긍정적

- Report download buttons no longer fail with S3 403 after idle periods -- the primary user-visible bug from commit `887e5b8` is eliminated.
- Download URLs cannot be shared outside the dashboard, aligning report distribution with the same RBAC the rest of the UI uses.
- Revoking a Cognito session revokes in-flight download capability at the same instant.
- Server-side logs now attribute each download to an authenticated user, improving incident forensics.
- Future S3-backed features inherit a proven pattern rather than reinventing URL expiry handling.

리포트 다운로드 버튼의 S3 403 실패가 사라졌고, URL 공유를 통한 대시보드 우회가 차단되며, 세션 철회가 즉시 반영되고, 사용자 단위 감사 추적이 가능하며, 향후 S3 기반 기능이 동일 패턴을 재사용할 수 있다.

### Negative / Trade-offs / 부정적 / 트레이드오프

- Every byte now transits the EC2 instance, adding bandwidth and memory overhead compared to browser-to-S3 direct transfer. For current report sizes (typically under 5 MB) this is negligible, but bulk export features would need streaming chunked responses.
- The proxy is a single-region bottleneck. Presigned URLs would have been fetched from the closest CloudFront edge / S3 regional endpoint. Users outside `ap-northeast-2` may see slightly higher download latency.
- Any future S3-backed download must be routed through the same proxy pattern. Ad-hoc features that link directly to S3 would silently regress the session-lifetime and revocability guarantees.
- The Next.js API layer now sits on the critical path for downloads; a dashboard outage blocks report retrieval even when S3 is healthy.

대역폭과 메모리 오버헤드 증가, 단일 리전 병목(엣지 캐싱 상실), 모든 신규 S3 다운로드에 동일 패턴 강제, 그리고 Next.js API 계층이 다운로드 경로의 장애점이 되는 트레이드오프를 수용한다.

## References / 참고 자료

### Internal
- [ADR-009](009-alert-triggered-ai-diagnosis.md): Alert-Triggered AI Diagnosis -- reports are also generated by the alert diagnosis pipeline and must use the same proxy pattern.
- `src/app/api/report/route.ts`: Report generation, S3 persistence, and proxy download endpoint.
- `src/app/ai-diagnosis/page.tsx`: Report UI using proxy download URLs.
- `src/lib/report-generator.ts`, `src/lib/report-docx.ts`, `src/lib/report-pptx.ts`, `src/lib/report-pdf.ts`: Report artifact generators.
- `src/lib/auth-utils.ts`: Cognito session extraction used by the proxy authentication check.
- [CLAUDE.md](../../CLAUDE.md): Root project context (reportBucket config, Cognito auth chain).

### External
- [AWS S3 Presigned URLs -- credential lifetime](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [AWS STS temporary credentials -- session duration](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_disable-perms.html)
- [MDN Content-Disposition](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition)
