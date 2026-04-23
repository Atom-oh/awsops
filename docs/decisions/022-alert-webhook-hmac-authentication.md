# ADR-022: Alert Webhook HMAC-SHA256 Authentication with Secret Rotation / 알림 웹훅 HMAC-SHA256 인증과 시크릿 회전

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops is fronted by CloudFront with a Lambda@Edge viewer-request function that rejects any HTTP request without a valid Cognito session cookie. This protects the dashboard UI and every `/awsops/api/*` route from unauthenticated access. However, the alert pipeline documented in ADR-009 must accept push-style webhooks from VPC-internal sources — Prometheus Alertmanager, Grafana Unified Alerting, and generic custom emitters — that cannot hold a browser session and cannot obtain a Cognito JWT. These sources reach the ALB directly inside the VPC, bypassing CloudFront, and post JSON payloads to `POST /awsops/api/alert-webhook`. The endpoint therefore has to accept unauthenticated TCP connections yet still prove that each payload originates from a trusted emitter and has not been tampered with in transit. ADR-009 defined the alert ingestion and correlation pipeline; ADR-012 defined the SNS → SQS path for CloudWatch alarms where Lambda@Edge blocks direct SNS HTTP delivery. This ADR covers the *authentication scheme* that makes the webhook endpoint safe as the single exception to the Cognito-everywhere rule.

AWSops는 CloudFront + Lambda@Edge viewer-request 함수로 보호되며, 유효한 Cognito 세션 쿠키가 없는 요청은 모두 차단된다. 이 기본 정책은 대시보드 UI와 모든 `/awsops/api/*` 라우트에 동일하게 적용된다. 그러나 ADR-009에서 정의한 알림 파이프라인은 VPC 내부의 Prometheus Alertmanager, Grafana Unified Alerting, 범용 커스텀 발신기로부터 푸시 방식 웹훅을 받아야 한다. 이 발신기들은 브라우저 세션을 유지하지 않고 Cognito JWT도 획득할 수 없다. 이들은 VPC 내부에서 ALB로 직접 접근해 `POST /awsops/api/alert-webhook` 에 JSON 페이로드를 전송한다. 따라서 이 엔드포인트는 인증되지 않은 TCP 연결을 받아들이면서도 각 페이로드가 신뢰된 발신기에서 왔고 전송 중 변조되지 않았음을 증명해야 한다. ADR-009는 파이프라인 전체를, ADR-012는 Lambda@Edge가 SNS HTTP를 차단하는 이유로 인해 SNS → SQS 경로를 채택한 결정을 다루었다. 이 ADR은 그 엔드포인트가 "Cognito 일괄 보호" 규칙의 유일한 예외로 존재해도 안전하도록 만드는 *인증 스킴* 을 정의한다.

## Options Considered / 검토한 대안

- **Option 1 — HMAC-SHA256 with per-source shared secrets (chosen).** Each alert source (`cloudwatch`, `alertmanager`, `grafana`, `sqs`, `generic`) owns an independent secret stored in `data/config.json` under `alertDiagnosis.sources[source].secret`. Senders compute `HMAC_SHA256(secret, rawBody)`, hex-encode it, and put it in a webhook signature header. The server recomputes the MAC over the raw body and compares in constant time. A planned active/standby rotation mode lets operators switch secrets without downtime by accepting both values during a rollover window.
- **Option 1 — HMAC-SHA256 소스별 공유 시크릿(채택).** 알림 소스(`cloudwatch`, `alertmanager`, `grafana`, `sqs`, `generic`) 별로 독립된 시크릿을 `data/config.json`의 `alertDiagnosis.sources[source].secret`에 저장한다. 발신기는 `HMAC_SHA256(secret, rawBody)`를 계산해 hex로 인코딩한 뒤 웹훅 서명 헤더에 실어 보내고, 서버는 원문 바디 위에서 MAC을 재계산해 상수 시간 비교한다. 활성/대기 회전 모드를 계획하여 롤오버 기간 동안 두 시크릿을 모두 허용해 무중단 교체가 가능하도록 한다.

- **Option 2 — Long-lived bearer token.** A single pre-shared token in a header such as `Authorization: Bearer …`. Simpler than HMAC but authenticates only the sender, not the payload: an attacker on the path who captures a token can replay or modify any subsequent request. Rotation requires coordinated restart of every sender.
- **Option 2 — 장기 베어러 토큰.** `Authorization: Bearer …` 헤더에 사전 공유 토큰 하나를 싣는 방식. HMAC보다 단순하지만 발신자만 인증할 뿐 페이로드는 검증하지 않는다. 경로 상에서 토큰을 탈취한 공격자는 이후 요청을 재전송하거나 수정할 수 있고, 토큰 회전 시 모든 발신기를 동시에 재시작해야 한다.

- **Option 3 — Mutual TLS (mTLS).** Client certificates issued to each emitter, verified at the ALB. Strongest authentication, but forces the operator to run a client PKI, distribute per-emitter certificates, and rotate them on expiry. Alertmanager and Grafana support mTLS but most operators do not already run a client CA for VPC-internal services.
- **Option 3 — 상호 TLS(mTLS).** 발신기별 클라이언트 인증서를 발급하고 ALB에서 검증. 가장 강한 인증이지만 클라이언트 PKI를 운영하고 인증서를 발급·회전해야 한다. Alertmanager/Grafana가 mTLS를 지원하지만 VPC 내부 서비스를 위해 클라이언트 CA를 이미 운영 중인 운영자는 드물다.

- **Option 4 — IP allowlist only, no signature.** Restrict the webhook path at the ALB security group to the VPC CIDR of known emitters. Trivially simple, but provides no payload integrity, no per-source identity, and any workload co-resident in that CIDR (a Lambda, a container, a compromised jump host) can inject arbitrary alerts.
- **Option 4 — 서명 없이 IP 허용 목록만.** ALB 보안 그룹에서 알려진 발신기 VPC CIDR만 허용. 매우 단순하지만 페이로드 무결성과 소스별 신원을 제공하지 않으며, 해당 CIDR 내부의 어떤 워크로드(Lambda·컨테이너·탈취된 점프 호스트 등)라도 임의의 알림을 주입할 수 있다.

## Decision / 결정

AWSops uses HMAC-SHA256 with per-source shared secrets and constant-time comparison, implemented in `src/app/api/alert-webhook/route.ts`. When a POST arrives, the handler first applies rate limiting (60 requests per minute per client IP, extracted as the second-to-last entry of `x-forwarded-for` because CloudFront and ALB each append one hop). It then parses the raw body once, handles SNS subscription confirmation by validating the `SubscribeURL` against the `^https://sns\.[a-z0-9-]+\.amazonaws\.com/` pattern before fetching it, detects the source from the payload shape via `detectAlertSource()` in `src/lib/alert-types.ts`, and looks up the configured secret via `getAlertSourceConfig(source)`. If the source has `enabled: true` and a non-empty `secret`, the handler reads the signature from one of `x-webhook-signature`, `x-hub-signature-256`, or `x-alertmanager-signature`, strips any `sha256=` prefix, and compares it to `createHmac('sha256', secret).update(rawBody).digest('hex')` using `crypto.timingSafeEqual`. On mismatch the request is rejected with HTTP 401. Sources with `enabled: false` get HTTP 403. After signature verification, normalized alerts whose timestamp is older than `deduplicationWindowMinutes` (default 15) are dropped as stale — this doubles as replay protection since an attacker replaying an old captured signed payload will fail the freshness check. Secrets are rendered as password-masked inputs on the admin-only `/alert-settings` page and are never returned to the UI in full; the field accepts free-form text and the CLAUDE.md for that page documents an active/standby rotation convention where operators put the standby value into the config, point emitters at it, then retire the previous value on the next edit.

AWSops는 HMAC-SHA256을 소스별 공유 시크릿과 상수 시간 비교로 적용하며, 구현은 `src/app/api/alert-webhook/route.ts`에 있다. POST가 도착하면 핸들러는 먼저 요청 속도를 제한한다(클라이언트 IP당 분당 60회, CloudFront와 ALB가 각각 한 홉씩 추가하므로 `x-forwarded-for` 의 끝에서 두 번째 값을 클라이언트 IP로 사용). 이어 원문 바디를 한 번 파싱하고, SNS 구독 확인의 경우 `SubscribeURL` 을 `^https://sns\.[a-z0-9-]+\.amazonaws\.com/` 정규식으로 검증한 뒤 호출한다. 그다음 `src/lib/alert-types.ts` 의 `detectAlertSource()` 로 페이로드 형태에서 소스를 추론하고 `getAlertSourceConfig(source)` 로 설정된 시크릿을 찾는다. 소스가 `enabled: true` 이고 `secret` 값이 비어 있지 않으면, 핸들러는 `x-webhook-signature`, `x-hub-signature-256`, `x-alertmanager-signature` 중 하나에서 서명을 읽어 `sha256=` 접두어를 제거한 뒤 `createHmac('sha256', secret).update(rawBody).digest('hex')` 와 `crypto.timingSafeEqual` 로 비교한다. 불일치면 HTTP 401, 소스가 비활성이면 HTTP 403으로 응답한다. 서명 검증 이후에는 타임스탬프가 `deduplicationWindowMinutes`(기본 15분) 보다 오래된 정규화 알림을 신선도 검사에서 탈락시키는데, 이는 곧 재전송 공격 방어로 작동한다 — 오래전 캡처한 서명 페이로드를 공격자가 다시 보내면 신선도 검사에서 걸러지기 때문이다. 시크릿은 관리자 전용 `/alert-settings` 페이지에서 비밀번호 입력 필드로 표시되며 UI로 원문이 반환되지 않는다. 해당 페이지 CLAUDE.md는 운영자가 대기 값을 설정에 넣고 발신기를 그쪽으로 전환한 뒤 다음 편집 시 이전 값을 폐기하는 활성/대기 회전 관행을 명시한다.

```text
Signature header   : x-webhook-signature | x-hub-signature-256 | x-alertmanager-signature
Signature encoding : hex (optional "sha256=" prefix)
MAC                : HMAC_SHA256(secret, rawBody) over the exact bytes of the request body
Comparison         : crypto.timingSafeEqual over equal-length hex Buffers
Replay window      : 15 minutes (deduplicationWindowMinutes, reuses correlation config)
Rate limit         : 60 requests / minute / client IP (map-based sliding counter, 10k entries max)
Secret storage     : data/config.json → alertDiagnosis.sources[source].secret (operator backs up)
Admin UI           : /alert-settings, password-masked, admin-only per adminEmails
```

## Rationale / 근거

- **HMAC-SHA256 over bearer tokens.** HMAC signs the request body, so any modification in transit — even a single byte flipped in an alert label — invalidates the signature. A bearer token only authenticates the sender and lets a path-level attacker rewrite the payload freely. For an endpoint that feeds downstream AI diagnosis and Slack routing, payload integrity matters as much as sender identity.
- **HMAC-SHA256 대 베어러 토큰.** HMAC은 요청 바디를 서명하므로 전송 중 단 한 바이트의 변조라도 서명이 무효화된다. 베어러 토큰은 발신자만 인증하고 경로 상 공격자가 페이로드를 자유롭게 수정할 수 있다. 하위로 AI 진단과 Slack 라우팅이 이어지는 엔드포인트이므로 발신자 신원만큼 페이로드 무결성이 중요하다.

- **`crypto.timingSafeEqual` for the comparison.** Node's `===` on strings short-circuits at the first differing character. A remote attacker who measures response time precisely can learn signatures byte by byte. `timingSafeEqual` performs a length-independent XOR over the full buffer, raising the cost of a timing side-channel to impractical levels.
- **비교에 `crypto.timingSafeEqual` 사용.** Node의 문자열 `===` 는 첫 번째 불일치 문자에서 조기 종료하며, 응답 시간을 정밀히 측정하는 원격 공격자는 서명을 바이트 단위로 복원할 수 있다. `timingSafeEqual` 은 길이와 무관한 XOR 전수 비교를 수행해 타이밍 사이드 채널 공격 비용을 비현실적 수준으로 끌어올린다.

- **Reusing `deduplicationWindowMinutes` as the replay window.** The pipeline already drops alerts older than the correlation deduplication window because stale alerts do not reflect current state. Piggybacking replay protection on the same threshold gives one tunable instead of two and matches operator intuition ("if an alert is too old to correlate, it is too old to react to").
- **`deduplicationWindowMinutes` 재사용으로 재전송 방어.** 파이프라인은 이미 상관 중복 제거 윈도우보다 오래된 알림을 현재 상태를 반영하지 못한다는 이유로 버린다. 동일 임계값에 재전송 방어를 얹으면 조정 변수가 두 개가 아닌 하나로 유지되며 운영자 직관("상관에 쓰기에 너무 오래된 알림은 대응에도 너무 오래되었다")과 일치한다.

- **Per-source secrets, not one global secret.** A compromise in Alertmanager's secret must not forge Grafana or CloudWatch alerts. Per-source keys also let an operator rotate one emitter without coordinating with the others.
- **글로벌 단일 시크릿이 아닌 소스별 시크릿.** Alertmanager의 시크릿이 유출되어도 Grafana/CloudWatch 알림은 위조되어서는 안 된다. 소스별 키는 한 발신기를 다른 발신기와 조율 없이 회전시킬 수 있게 한다.

- **No mTLS.** mTLS would authenticate at the ALB layer before the request even reached Next.js, which sounds ideal, but every operator deploying AWSops would have to run a client CA, issue certificates to Alertmanager and Grafana, and rotate them. HMAC with a shared secret is a much lower operational lift for the target audience (SRE teams running VPC-internal monitoring they already control) and is supported natively by every alert emitter in scope.
- **mTLS 미채택.** mTLS는 요청이 Next.js에 도달하기 전 ALB 층에서 인증을 끝낼 수 있어 이상적으로 보이지만, AWSops를 배포하는 모든 운영자가 클라이언트 CA를 운영하고 Alertmanager/Grafana에 인증서를 발급·회전해야 한다. 공유 시크릿 기반 HMAC는 이미 VPC 내부 모니터링을 운영하는 SRE 팀에게 운영 부담이 훨씬 낮고, 대상 발신기들이 모두 네이티브로 지원한다.

## Security Considerations / 보안 고려 사항

- **Secret length.** Secrets are free-form strings in `data/config.json`. Operators are expected to use at least 32 random bytes (256-bit security margin) — shorter secrets weaken HMAC's brute-force resistance. The UI does not enforce a minimum, so the operational runbook must.
- **시크릿 길이.** 시크릿은 `data/config.json` 의 자유 문자열이며, 운영자는 최소 32바이트의 난수(256비트 보안 마진)를 사용해야 한다. UI는 최소 길이를 강제하지 않으므로 운영 런북이 이를 명시해야 한다.

- **Secret storage at rest.** `data/config.json` lives on the EC2 instance's EBS volume. Encryption at rest is assumed from EBS-level encryption (configured in the CDK stack). Backups of `data/config.json` must apply the same protection. Secrets never appear in full in API responses — the admin UI renders them as password-masked fields — and are never written to application logs.
- **저장 시 시크릿 보호.** `data/config.json` 은 EC2의 EBS 볼륨에 저장되며 저장 시 암호화는 EBS 수준에서 보장된다(CDK 스택에서 설정). 해당 파일의 백업에도 동일한 보호가 적용되어야 한다. API 응답에 시크릿 원문이 포함되지 않으며(관리자 UI는 비밀번호 마스킹), 애플리케이션 로그에도 기록되지 않는다.

- **Signature mismatch surface.** The endpoint returns a flat `401 Invalid signature` for every failure mode — wrong header, wrong encoding, wrong length, wrong MAC — so a probing attacker cannot distinguish "wrong secret" from "wrong algorithm". `timingSafeEqual` throws when buffer lengths differ; the catch in `verifySignature` returns `false` uniformly.
- **서명 불일치 노출 면.** 엔드포인트는 모든 실패 경로(헤더 누락·인코딩 오류·길이 불일치·MAC 불일치)에 대해 평평하게 `401 Invalid signature` 를 반환하므로, 프로빙 공격자는 "시크릿 오류"와 "알고리즘 오류"를 구분할 수 없다. `timingSafeEqual` 은 버퍼 길이가 다르면 예외를 던지며, `verifySignature` 내부 `catch` 가 이를 일괄 `false` 로 변환한다.

- **Rate limit as DoS mitigation, not authentication.** The 60/min/IP limit exists to cap CPU consumed by HMAC verification during an alert storm or a misconfigured emitter — not to authenticate. When the map grows past 10 000 entries expired rows are pruned; this is coarse but adequate for a VPC-internal endpoint.
- **인증이 아닌 DoS 완화로서의 속도 제한.** 분당 60회/IP 제한은 알림 폭주나 설정 오류 상황에서 HMAC 검증이 소비하는 CPU를 상한하기 위한 것이지 인증 수단이 아니다. 맵이 1만 엔트리를 넘으면 만료 행을 전지하며, VPC 내부 엔드포인트용으로는 충분한 수준의 coarse 구현이다.

- **Rotation operational model.** Rotation is cooperative between operator and emitter: change the secret in `/alert-settings`, update the emitter, verify accepted alerts, then remove any exposure of the old value. The current implementation holds a single active secret per source; the UI is wired to support an active/standby pair as documented in `src/app/alert-settings/CLAUDE.md`, but the verifier currently accepts exactly one value at a time. Until the standby field lands in `AlertSourceConfig`, rotation requires a brief coordination window; emitters may be batched per source to keep the window short.
- **회전 운영 모델.** 회전은 운영자와 발신기의 협력으로 수행된다 — `/alert-settings` 에서 시크릿을 교체하고, 발신기를 갱신한 뒤, 수신이 정상인지 확인하고, 이전 값의 노출을 제거한다. 현재 구현은 소스당 단일 활성 시크릿을 보관하며, UI는 `src/app/alert-settings/CLAUDE.md` 에 기록된 활성/대기 쌍을 전제로 설계되었으나 검증기는 현시점에 한 번에 하나의 값만 허용한다. `AlertSourceConfig` 에 standby 필드가 도입되기 전까지 회전은 짧은 조율 창이 필요하며, 소스별로 발신기를 묶어 창을 최소화한다.

## Consequences / 결과

### Positive / 긍정

- **Cognito-incompatible emitters can deliver alerts without weakening the dashboard's auth posture.** The webhook endpoint is the only exception to the Cognito-everywhere rule, and that exception is bounded by HMAC + rate limit + replay window.
- **Cognito를 사용할 수 없는 발신기도 대시보드 전체 인증 정책을 약화시키지 않고 알림을 전달할 수 있다.** 웹훅 엔드포인트가 유일한 예외이며, 그 예외는 HMAC + 속도 제한 + 재전송 방어 윈도우로 경계가 제한된다.

- **Payload integrity is end-to-end.** Any modification between emitter and ALB invalidates the signature.
- **페이로드 무결성이 종단 간 보장된다.** 발신기와 ALB 사이에서 일어난 어떤 수정도 서명을 무효화한다.

- **Per-source keys isolate blast radius.** A leaked Alertmanager secret does not forge Grafana or CloudWatch alerts.
- **소스별 키로 피해 반경이 격리된다.** Alertmanager 시크릿 유출은 Grafana/CloudWatch 알림 위조로 번지지 않는다.

- **Timing-side-channel resistant.** Signature comparison runs in constant time regardless of where the first differing byte lies.
- **타이밍 사이드 채널에 강하다.** 서명 비교는 첫 불일치 바이트 위치와 무관하게 상수 시간에 수행된다.

### Negative / 부정

- **Operator is responsible for secret distribution and backup.** Secrets must be copied into each emitter out of band (Alertmanager config, Grafana contact point, custom script). `data/config.json` must be backed up with the same care as any other credential store.
- **운영자가 시크릿 배포와 백업을 책임진다.** 시크릿은 각 발신기(Alertmanager 설정, Grafana contact point, 커스텀 스크립트)에 대역 외로 복사해야 하며, `data/config.json` 은 다른 자격 증명 저장소와 동일한 수준으로 백업되어야 한다.

- **Replay window is a tradeoff.** The 15-minute default is wide enough that clock drift between emitters and EC2 rarely causes rejections, but it leaves a 15-minute replay opportunity for a captured signed payload. Operators with stricter requirements can lower `deduplicationWindowMinutes`, at the cost of more "stale alert" rejections during clock skew.
- **재전송 윈도우는 트레이드오프다.** 15분 기본값은 발신기와 EC2의 시계 편차로 인한 기각이 드물 만큼 넉넉하지만, 탈취한 서명 페이로드에 대한 15분 창을 남긴다. 더 엄격한 요건을 가진 운영자는 `deduplicationWindowMinutes` 를 낮출 수 있으나 시계 편차로 인한 "stale alert" 기각이 늘어난다.

- **HMAC verification adds CPU per request.** SHA-256 over a few-kilobyte payload is cheap, but a misconfigured emitter firing at thousands of requests per second would consume EC2 CPU; the 60/min/IP rate limit and the map-pruning guard are the mitigations.
- **요청당 HMAC 검증 CPU가 추가된다.** 수 킬로바이트 페이로드 위 SHA-256 자체는 가볍지만, 설정 오류로 초당 수천 요청을 발사하는 발신기는 EC2 CPU를 소진할 수 있다. 분당 60회/IP 제한과 맵 전지 가드가 완화 수단이다.

- **Rotation currently requires a brief window.** Until an active/standby pair lives in `AlertSourceConfig`, operators must coordinate a short changeover when rotating; the `/alert-settings` UI treats this as a single-value edit.
- **현재 회전은 짧은 창이 필요하다.** `AlertSourceConfig` 에 활성/대기 쌍이 도입되기 전까지 운영자는 전환 시 짧은 조율 창을 가져야 하며, `/alert-settings` UI도 단일 값 편집으로 동작한다.

## References / 참고

- Code: `src/app/api/alert-webhook/route.ts` (HMAC verification at lines 67-76; signature header lookup and check at 132-140; rate limit at 42-57; replay filter at 142-158)
- Code: `src/app/alert-settings/page.tsx` (password-masked secret input; per-source toggle and routing)
- Code: `src/lib/alert-types.ts` (source detection and per-source normalizers)
- Code: `src/lib/app-config.ts` (`AlertSource`, `AlertSourceConfig`, `AlertDiagnosisConfig`; `getAlertSourceConfig`)
- Page context: `src/app/alert-settings/CLAUDE.md` (active/standby rotation convention)
- ADR-009: Alert-triggered AI diagnosis pipeline — defines the ingestion, correlation, and diagnosis stages that consume what this ADR authenticates.
- ADR-012: SNS notification strategy — documents why CloudWatch alarms take the SNS → SQS path instead of posting directly to this webhook, because CloudFront Lambda@Edge blocks unauthenticated SNS HTTP.
- Cognito + Lambda@Edge auth posture: `infra-cdk/lib/cognito-stack.ts`, referenced in the root `CLAUDE.md` under "인증 / Auth". This endpoint is the single documented exception to that posture.
