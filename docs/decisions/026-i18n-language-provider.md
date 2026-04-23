# ADR-026: i18n via LanguageProvider + Flat Translation Maps / LanguageProvider + 평면 번역 맵 기반 다국어 지원

## Status / 상태

Accepted (2026-04-22)

채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops serves Korean and English operators working in ap-northeast-2. The UI carries roughly 1500 translation keys across 40 pages — service names, column headers, button labels, and short helper text. There are no plurals, gender agreements, or date/number formats that require ICU-level tooling. The Next.js 14 App Router runs almost entirely as client components (`'use client'`), so server-side i18n machinery brings no rendering benefit. The dashboard also passes the chosen language down to AgentCore prompts and collector pipelines so that AI responses arrive in the user's language, not translated after the fact.

AWSops는 ap-northeast-2 리전에서 근무하는 한국/영어 운영자를 대상으로 한다. UI는 40개 페이지에 걸쳐 약 1500개의 번역 키를 갖고 있으며 서비스 이름, 컬럼 헤더, 버튼 레이블, 짧은 도움말이 대부분이다. 복수형, 성별 일치, 날짜/숫자 포맷 같은 ICU 수준의 처리가 필요한 문구는 없다. Next.js 14 App Router는 거의 전체를 클라이언트 컴포넌트(`'use client'`)로 렌더링하므로 서버 측 i18n 장치가 제공하는 이점이 없다. 또한 대시보드는 선택된 언어를 AgentCore 프롬프트와 컬렉터 파이프라인에 그대로 넘겨서 AI 응답이 사후 번역이 아닌 선택 언어로 직접 생성되도록 한다.

## Options Considered / 검토한 대안

### Option 1 — Custom `LanguageProvider` + flat translation maps (chosen)

A React Context in `src/lib/i18n/LanguageContext.tsx` exposes `{ lang, setLang, t }`. Translations live in two JSON files (`translations/en.json`, `translations/ko.json`) as flat key-value maps. The provider is mounted once in `src/components/providers/ClientProviders.tsx`. Language preference is persisted in `localStorage` under `awsops-lang` and defaults to `ko`.

`src/lib/i18n/LanguageContext.tsx`의 React Context가 `{ lang, setLang, t }`를 제공한다. 번역은 두 개의 JSON 파일(`translations/en.json`, `translations/ko.json`)에 평면 키-값 맵으로 저장된다. 프로바이더는 `src/components/providers/ClientProviders.tsx`에서 한 번 마운트된다. 언어 설정은 `localStorage`의 `awsops-lang` 키에 저장되며 기본값은 `ko`이다.

### Option 2 — `next-i18next` or `next-intl`

These libraries are the standard Next.js i18n choices. `next-i18next` targets the pages router and its App Router integration is awkward; `next-intl` fits App Router but introduces route segmentation (`/en/...`, `/ko/...`) that collides with our `basePath: '/awsops'` and CloudFront path mapping.

두 라이브러리는 Next.js의 표준 i18n 선택지이다. `next-i18next`는 pages router 대상이어서 App Router 통합이 어색하고, `next-intl`은 App Router에 맞지만 라우트 세그먼트(`/en/...`, `/ko/...`)를 도입하는데 이는 `basePath: '/awsops'`와 CloudFront 경로 매핑과 충돌한다.

### Option 3 — `react-intl` / `formatjs`

The ICU message format family supports plurals, genders, and rich number/date formatting. The cost is a heavier runtime, an ICU compiler in the build pipeline, and a learning curve for every contributor adding a string.

ICU 메시지 포맷 계열은 복수형, 성별, 풍부한 숫자/날짜 포맷을 지원한다. 대신 더 무거운 런타임, 빌드 파이프라인의 ICU 컴파일러, 문자열을 추가하는 모든 기여자가 익혀야 하는 학습 곡선이 따라온다.

### Option 4 — No i18n, single language (Korean or English only)

Ship a single locale. Simplest, but excludes half of the operator base in mixed Korean/English teams and blocks MSP customers whose preferred language differs from the host deployment.

하나의 로케일만 제공. 가장 단순하지만 한국어/영어가 섞인 팀에서 절반을 배제하게 되고, 호스트 배포와 선호 언어가 다른 MSP 고객을 차단한다.

## Decision / 결정

Adopt Option 1. A custom `LanguageProvider` wraps the application in `ClientProviders.tsx`; flat JSON translation maps are statically imported and bundled. Components consume translations through the `useLanguage()` hook (`{ lang, setLang, t }`). Language choice persists in `localStorage` and propagates to AgentCore prompts via the `lang` parameter so the LLM answers in the user's language directly.

Option 1을 채택한다. 커스텀 `LanguageProvider`가 `ClientProviders.tsx`에서 애플리케이션을 감싸고, 평면 JSON 번역 맵을 정적으로 import 하여 번들에 포함한다. 컴포넌트는 `useLanguage()` 훅(`{ lang, setLang, t }`)을 통해 번역에 접근한다. 언어 선택은 `localStorage`에 저장되고 `lang` 파라미터로 AgentCore 프롬프트에 전달되어 LLM이 선택 언어로 직접 응답하게 한다.

```tsx
// src/lib/i18n/LanguageContext.tsx
const translations: Record<Language, Record<string, string>> = { en, ko };
const saved = localStorage.getItem('awsops-lang') as Language;
const t = (key, params) => {
  let text = translations[lang]?.[key] || translations['en']?.[key] || key;
  // {count} 스타일 파라미터 보간
  return text;
};
```

## Rationale / 근거

- **Audience fit**: Two languages, ~1500 short labels, no plural or gender complexity — the problem space matches a flat map, not ICU.
- **App Router alignment**: Avoids route-segmented locales (`/en/...`) that conflict with `basePath: '/awsops'` and the CloudFront distribution. A context provider is router-agnostic.
- **Zero dependency**: No third-party i18n runtime; the entire system is ~60 lines in `LanguageContext.tsx`.
- **Bundled, not lazy-loaded**: Both translation files together are well under 50 KB; lazy loading would add a loading state to every page for negligible bundle savings.
- **Manual toggle over browser auto-detect**: Operators in bilingual Korean teams often have browser-locale mismatches; a deterministic toggle in the Sidebar is more predictable.
- **React Context is enough**: Translations are read-heavy and only mutate on language switch; Context re-render is bounded and acceptable — Zustand/Redux would be over-engineering.
- **AI responses stay untranslated**: The `lang` flag passes through to collectors (see ADR-013) and SSE streaming routes (see ADR-021) so Bedrock answers in the chosen language end-to-end. No post-hoc translation layer.

근거:

- **대상 적합성**: 두 개 언어, 약 1500개의 짧은 레이블, 복수/성별 복잡도 없음 — 문제 영역이 ICU가 아닌 평면 맵에 맞다.
- **App Router 정합성**: `basePath: '/awsops'` 및 CloudFront 배포와 충돌하는 세그먼트 기반 로케일(`/en/...`)을 피한다. Context 프로바이더는 라우터 비의존적이다.
- **외부 의존 0**: 서드파티 i18n 런타임 없음. 전체 시스템이 `LanguageContext.tsx` 약 60줄 수준이다.
- **번들 포함, 지연 로딩 없음**: 두 번역 파일 합계가 50 KB 미만이며, 지연 로딩은 모든 페이지에 로딩 상태만 추가할 뿐 번들 절감은 미미하다.
- **브라우저 자동 감지 대신 수동 토글**: 한국어/영어가 혼재된 팀에서는 브라우저 로케일이 불일치하는 경우가 흔하므로 Sidebar의 명시적 토글이 더 예측 가능하다.
- **React Context로 충분**: 번역은 읽기 편중이며 언어 전환 시에만 변경된다. Context 재렌더는 제한적이고 수용 가능하며 Zustand/Redux는 과설계이다.
- **AI 응답 재번역 없음**: `lang` 플래그가 컬렉터(ADR-013 참고)와 SSE 스트리밍 라우트(ADR-021 참고)까지 전달되어 Bedrock이 처음부터 선택 언어로 응답한다. 사후 번역 레이어는 없다.

## Consequences / 결과

### Positive / 긍정적 결과

- Zero external i18n dependency; no version upgrades, no CVE surface from that direction.
- Adding a new string is a one-line edit in two files; missing keys are auditable with a simple grep.
- Language switch is instantaneous (no network fetch, no suspense boundary).
- UI language and AI response language stay aligned end-to-end through the `lang` parameter.
- Default-to-`ko` with fallback to `en` means missing keys degrade gracefully instead of showing `undefined`.

외부 i18n 의존이 없어 버전 업그레이드와 CVE 표면이 줄어든다. 새 문자열 추가는 두 파일에서 한 줄 편집으로 끝나고 누락 키는 단순 grep으로 감사 가능하다. 언어 전환이 즉시 이루어지며 네트워크 요청이나 Suspense 경계가 없다. `lang` 파라미터를 통해 UI 언어와 AI 응답 언어가 끝까지 일치한다. 기본 `ko` + 영어 폴백 구조로 누락 키도 `undefined` 대신 자연스럽게 대체된다.

### Negative / 부정적 결과 및 트레이드오프

- No plural or gender handling if business logic later demands it (e.g., "1 instance" vs "N instances" with proper grammar).
- No offline translator tooling (Crowdin, Lokalise) integration; translators edit JSON directly.
- Adding a third language requires touching every existing translation file and expanding the `Language` union type.
- No fallback cascade beyond a single default language; there is no notion of regional variants (`en-GB` vs `en-US`).
- Language preference lives in `localStorage` only — private-mode sessions and new browsers always start in Korean.

복수형/성별 처리가 필요해지면(예: "1 instance" vs "N instances"의 정확한 문법) 대응할 수 없다. Crowdin, Lokalise 같은 오프라인 번역 도구 통합이 없으며 번역가가 JSON을 직접 편집해야 한다. 세 번째 언어를 추가하려면 기존 번역 파일 전체를 건드리고 `Language` 유니온 타입을 확장해야 한다. 단일 기본 언어 이상의 폴백 계층이 없고 지역 변형(`en-GB` vs `en-US`) 개념도 없다. 언어 설정은 `localStorage`에만 저장되므로 프라이빗 모드 세션과 새 브라우저는 항상 한국어로 시작한다.

## References / 참고 문헌

- `src/lib/i18n/LanguageContext.tsx` — Provider, `useLanguage` hook, `t(key, params)` interpolation, localStorage persistence
- `src/lib/i18n/CLAUDE.md` — i18n module overview and per-page usage rules
- `src/lib/i18n/translations/en.json`, `src/lib/i18n/translations/ko.json` — Flat translation maps (~1500 keys each)
- `src/components/providers/ClientProviders.tsx` — Where `LanguageProvider` wraps the app (above `AccountProvider`)
- [ADR-013](013-auto-collect-investigation-agents.md) — Auto-collect investigation agents accept an `isEn` / `lang` flag so collector output matches UI language
- [ADR-021](021-sse-streaming-ai-responses.md) — SSE streaming AI routes forward the `lang` parameter so Bedrock answers in the user's chosen language
