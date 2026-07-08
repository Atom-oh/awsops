# i18n 모듈 / i18n Module

## 역할 / Role
한국어/영어/중국어(간체) 다국어 지원. React Context + localStorage 방식 (URL 라우팅 없음, basePath 충돌 방지).
(Korean/English/Simplified-Chinese i18n. React Context + localStorage pattern — no URL routing to avoid basePath conflicts.)

## 주요 파일 / Key Files
- `LanguageContext.tsx` — LanguageProvider + useLanguage 훅 (lang, setLang, t 함수) + SUPPORTED_LANGUAGES
- `translations/en.json` — 영어 번역 (1,400+ 키)
- `translations/ko.json` — 한국어 번역 (1,400+ 키)
- `translations/zh.json` — 중국어(간체) 번역 (1,400+ 키)

## 사용법 / Usage
```tsx
const { lang, t } = useLanguage();
<span>{t('dashboard.title')}</span>
```

## 규칙 / Rules
- 기본 언어: 한국어 (ko). 지원 언어: ko / en / zh (간체)
- Sidebar 상단 토글 버튼으로 순환 전환: ko → en → zh → ko (버튼 표시: EN → 中 → 한)
- 새 페이지/컴포넌트 추가 시 en.json + ko.json + zh.json 모두에 키 추가
- `t('key', { count: 5 })` 형태로 파라미터 치환 지원
- AI 응답도 언어 설정 반영 (`lang` 파라미터 전달, zh → 简体中文 응답)
- AI 진단 리포트: `lang`('ko'|'en'|'zh')로 생성 — 섹션 제목은 report-prompts.ts의 title/titleKo/titleZh
- 수집기(collectors) 내부 진행 메시지는 en/ko만 지원 — zh는 영어로 폴백
