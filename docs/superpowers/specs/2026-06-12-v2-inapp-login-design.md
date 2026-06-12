# v2 인앱 로그인 — 설계 (2026-06-12)

> v2 web에 **v1식 인앱 로그인 페이지**(`/login`)를 도입한다. 외형은 **AgentCore 테마(L2 teal, 토큰 기반)**, 인증은 **Cognito `USER_PASSWORD_AUTH`** 로 `awsops_token` 쿠키를 설정한다. 엣지 Lambda는 미인증 시 Cognito Hosted UI 대신 `/login`으로 보낸다.

## 배경 / 동기
- v1은 커스텀 로그인 페이지(`src/app/login/page.tsx`)가 있었다 — 이메일/비번 폼 → `/api/auth`(Cognito `USER_PASSWORD_AUTH`) → `awsops_token`(IdToken) 쿠키 → 대시보드.
- v2는 현재 **앱 내 로그인 페이지가 없다**. 엣지 Lambda(`cognito_edge.py.tftpl`)가 미인증 요청을 **Cognito Hosted UI(`/login`)로 302** 한다.
- 사용자 요청: "v1처럼 로그인 화면도 구성." → **구조/동작은 v1식 인앱 폼**, **외형은 v2(AgentCore) 테마**.
- 핵심 호환성: v1이 설정하던 `awsops_token`(IdToken) 쿠키 포맷이 **v2 엣지가 검증하는 것과 동일**(`verify_rs256` + `claims_valid`의 `token_use=='id'`). → 인앱 폼이 v2 엣지와 그대로 호환.

## 결정 (brainstorm 확정)
- **외형**: L2 · AgentCore Teal(라이트). **테마 토큰 기반**으로 작성 → 활성 테마를 따름(console 테마면 자동 다크). [[awsops-v2-effort]]의 AgentCore 테마 시스템에 의존.
- **인증**: v1식 인앱 폼 + Cognito `USER_PASSWORD_AUTH`. (대안 "브랜드 랜딩→Hosted UI"는 기각.)
- **AppShell**: `usePathname` 게이트(client 전환) — `/login`은 사이드바·CommandPalette·ChatDrawer 없이 풀스크린. (route group 이동 대신 저churn.)
- **ADR**: ADR-039 작성 — Hosted UI+PKCE → 인앱 USER_PASSWORD_AUTH 부분 변경 기록.

## 의존성
이 기능의 로그인 페이지는 **AgentCore 테마 시스템 spec/plan**(`2026-06-12-agentcore-theme-system-*`)의 토큰 레이어(`bg-paper`, `text-ink-*`, `bg-brand-action`, chrome/positive 토큰)를 사용한다. **테마 plan Task 1–2(토큰→CSS변수 + `--brand-action`) 적용 후** 본 로그인 구현을 진행한다(권장 순서: 테마 → 로그인).

## 인증 흐름
```
[미인증 요청] → 엣지 Lambda(viewer-request)
   ├─ is_public(/login, /api/auth/*, /_next/static/, /api/health, /icon.svg) → pass
   └─ 그 외 + 유효 awsops_token 없음 → 302  /login?next=<원래 URI>
[/login 페이지(공개)] → 이메일·비번·remember 폼
   → POST /api/auth/login (공개)
       → Cognito InitiateAuth(USER_PASSWORD_AUTH, 공개 PKCE 클라이언트 → SECRET_HASH 없음)
       → IdToken 수령
       → Set-Cookie awsops_token=<IdToken>; HttpOnly; Secure; SameSite=Lax; Max-Age=remember?30d:1h
   → 클라이언트가 next(같은 출처 경로만)로 이동, 기본 '/'
[이후 요청] → 엣지가 RS256+claims 검증 통과 → 정상
```
- `/_callback`(기존 OAuth/PKCE 콜백)은 **보존**(Hosted UI 폴백/페더레이션 여지). 단 기본 미인증 리다이렉트는 `/login`.
- **open-redirect 방지**: `next`는 `/`로 시작하는 같은 출처 상대경로만 허용(`//`·`http(s):`·`\` 거부), 아니면 `/`.

## 설계 — 컴포넌트별

### A. 로그인 페이지 `web/app/login/page.tsx` (신규, client)
- L2 디자인을 **테마 토큰**으로: 배경 `bg-paper`(은은한 teal/azure radial glow 2개), 중앙 카드 `bg-white border-ink-100 shadow-card`(다크 테마에선 chrome 토큰), 상단 `AwsopsMark`(teal 타일) + "AWSops" + "Sign in to continue".
- 필드: Email(`type=email`), Password(`type=password`), Remember 체크박스. `Input` UI 컴포넌트 재사용.
- 버튼: "Sign in →" `bg-brand-action text-white`(AA). 로딩 스피너, 에러 박스(`bg-negative-surface text-negative-text border-negative-border`, shake).
- 푸터: "Systems online" + `bg-positive` 닷.
- 동작: `next`는 `useSearchParams()`에서 읽어 sanitize. submit → `fetch('/api/auth/login', {method:'POST', body:{email,password,remember}})` → 성공 시 `window.location.href = next`.
- 페이지 자체는 AppShell 밖(아래 C) → 풀스크린.

### B. 로그인 API `web/app/api/auth/login/route.ts` (신규, POST)
- `@aws-sdk/client-cognito-identity-provider` `InitiateAuthCommand`, `AuthFlow: 'USER_PASSWORD_AUTH'`, `ClientId: COGNITO_CLIENT_ID`, `AuthParameters: { USERNAME, PASSWORD }`(공개 클라이언트 → SECRET_HASH 없음).
- env: `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`(D 참조).
- 성공: `IdToken` → `Set-Cookie awsops_token=...; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age`(remember 30d / else 1h). `{ ok: true }`.
- 챌린지(MFA/NEW_PASSWORD 등): `{ error, challenge }` 403 — 안내(현재 범위에선 미지원, Hosted UI 폴백 권장).
- Cognito 에러 매핑: NotAuthorized/UserNotFound → 401 "Invalid email or password"; NotConfirmed/PasswordResetRequired → 403 안내. **비번·토큰 로깅 금지**, 에러는 user-safe 문구만.
- 의존성: `@aws-sdk/client-cognito-identity-provider`가 `web/package.json`에 **없으면 추가**(현재 미설치 — 확인 필요).

### C. AppShell `web/components/shell/AppShell.tsx` (리팩터 → client)
- `'use client'` + `usePathname()`. `/login`이면 `<main className="min-h-screen">{children}</main>`만(사이드바/Cmd-K/Chat 없음). 그 외엔 기존 `Sidebar + main + CommandPalette + ChatDrawer`.
- `layout.tsx`의 `<CommandPalette/>`·`<ChatDrawer/>`를 AppShell 내부로 이동(로그인에서 함께 숨기기 위함). `layout.tsx`는 `<LanguageProvider><AppShell>{children}</AppShell></LanguageProvider>`로 축소.
- 주의: AppShell이 client여도 `children`(server)은 prop으로 받아 그대로 렌더 → 페이지의 server 렌더링 유지.

### D. 엣지 Lambda `terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl`
- `is_public(uri)`: 기존(`/_next/static/`, `/api/health`, `/api/auth/signout`)에 더해 `uri == '/login'`, `uri.startswith('/api/auth/')`, `uri == '/icon.svg'` 허용.
- `start_login(headers)`: 현재 Cognito Hosted UI URL 대신 **`/login?next=<현재 uri>`로 302**. (현재 요청 uri를 query에 안전 인코딩.)
- `/_callback` 핸들러·RS256 검증은 변경 없음(보존).
- 변경 시 **CloudFront 재배포 필요(느림 → 컨트롤러 apply)**.

### E. Cognito `terraform/v2/foundation/auth.tf`
- 앱 클라이언트 `explicit_auth_flows`에 `ALLOW_USER_PASSWORD_AUTH` 추가(+ 기존 `ALLOW_REFRESH_TOKEN_AUTH` 등 보존). 공개 PKCE 클라이언트(시크릿 없음) 유지.

### F. web 태스크 env `terraform/v2/foundation/workload.tf`
- web 컨테이너 `environment`에 `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` 추가(비밀 아님 → `secrets` valueFrom 아님, 평문 env). 값은 auth.tf 출력/리소스 참조.

### G. 로그아웃 점검 `web/app/api/auth/signout/route.ts`
- 사후 리다이렉트가 `/login`(또는 적절한 위치)을 향하도록 확인/수정. (엣지 `is_public`에 이미 포함.)

### H. ADR-039 `docs/decisions/ADR-039-*.md`
- 제목: v2 인앱 로그인(USER_PASSWORD_AUTH). 맥락(037 Hosted UI+PKCE), 결정, 트레이드오프(앱이 비번 처리·MFA/재설정/페더레이션 UI 부재·USER_PASSWORD_AUTH), 폴백(`/_callback` 보존), 대안(브랜드 랜딩→Hosted UI) 기각 사유. `docs/decisions/CLAUDE.md` 인덱스 갱신.

## 범위 밖 (YAGNI)
- MFA/NEW_PASSWORD/비번 재설정 인앱 플로우 — 챌린지는 안내만(추후 Hosted UI 폴백).
- 소셜/페더레이션 로그인 UI.
- SRP(ALLOW_USER_SRP_AUTH) — v1과 동일하게 USER_PASSWORD_AUTH 사용(HTTPS 전제). 추후 강화 가능.
- 회원가입/셀프 등록 — 사용자 프로비저닝은 Cognito 콘솔/관리자.

## 보안 노트
- 비번은 HTTPS로 web BFF→Cognito 전달. 라우트에서 **비번/토큰 절대 로깅 금지**.
- 쿠키 HttpOnly·Secure·SameSite=Lax. 잠금/쓰로틀은 Cognito 기본.
- `next` open-redirect 방지(같은 출처 상대경로만).
- `/api/auth/login` 공개지만 상태 변경은 쿠키 설정뿐(자격증명 검증은 Cognito).

## 테스트 / 검증
- vitest: `app/api/auth/login/route.test.ts`(node env) — env 미설정 500, 누락 필드 400, Cognito 에러 매핑(client 모킹), 성공 시 Set-Cookie. `next` sanitize 유닛(`lib`로 분리 시).
- AppShell: `/login`에서 사이드바 미렌더 / 그 외 렌더(jsdom + usePathname 모킹).
- 빌드: `next build` 통과.
- 수동: 미인증 접속→`/login` 리다이렉트, 폼 로그인→쿠키→대시보드, 잘못된 비번 에러, remember 만료, 다크(console) 테마 시 로그인도 다크.
- 배포: web=`make deploy`. 엣지/Cognito/workload env = **terraform plan→컨트롤러 apply**(엣지 변경은 CloudFront 재배포 동반, 느림).

## 파일 영향 요약
| 파일 | 변경 |
|--|--|
| `web/app/login/page.tsx` | 신규 — L2 teal 로그인(토큰 기반) |
| `web/app/api/auth/login/route.ts` | 신규 — USER_PASSWORD_AUTH → 쿠키 |
| `web/components/shell/AppShell.tsx` | client 전환 + pathname 게이트 + Cmd-K/Chat 이동 |
| `web/app/layout.tsx` | Cmd-K/Chat을 AppShell로 이관 |
| `web/app/api/auth/signout/route.ts` | 사후 `/login` 향하도록 점검 |
| `web/package.json` | (필요 시) `@aws-sdk/client-cognito-identity-provider` 추가 |
| `terraform/v2/foundation/edge-lambda/cognito_edge.py.tftpl` | is_public 확장 + start_login→/login |
| `terraform/v2/foundation/auth.tf` | 앱클라이언트 ALLOW_USER_PASSWORD_AUTH |
| `terraform/v2/foundation/workload.tf` | web env: COGNITO_REGION/USER_POOL_ID/CLIENT_ID |
| `docs/decisions/ADR-039-*.md` + `docs/decisions/CLAUDE.md` | ADR 작성 + 인덱스 |
