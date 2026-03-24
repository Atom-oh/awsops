# i18n 모듈 / i18n Module

## 역할 / Role
한국어/영어 다국어 지원. React Context + localStorage 방식 (URL 라우팅 없음, basePath 충돌 방지).
(Korean/English i18n. React Context + localStorage pattern — no URL routing to avoid basePath conflicts.)

## 주요 파일 / Key Files
- `LanguageContext.tsx` — LanguageProvider + useLanguage 훅 (lang, setLang, t 함수)
- `translations/en.json` — 영어 번역 (500+ 키)
- `translations/ko.json` — 한국어 번역 (500+ 키)

## 사용법 / Usage
```tsx
const { lang, t } = useLanguage();
<span>{t('dashboard.title')}</span>
```

## 규칙 / Rules
- 기본 언어: 한국어 (ko)
- Sidebar 상단 EN/한 토글 버튼으로 전환
- 새 페이지/컴포넌트 추가 시 en.json + ko.json 모두에 키 추가
- `t('key', { count: 5 })` 형태로 파라미터 치환 지원
- AI 응답도 언어 설정 반영 (`lang` 파라미터 전달)
