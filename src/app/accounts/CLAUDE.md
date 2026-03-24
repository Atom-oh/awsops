# 계정 관리 모듈 / Accounts Module

## 역할 / Role
멀티 어카운트 관리 페이지. Admin 전용 접근 제어.
(Multi-account management page. Admin-only access control.)

## 주요 파일 / Key Files
- `page.tsx` — 계정 추가/삭제/테스트 UI, Host 계정 자동 감지

## 접근 제어 / Access Control
- `adminEmails` config 설정 시 해당 이메일만 접근 허용
- 비 admin 사용자: "Access Denied" 화면 (Shield 아이콘)
- API도 동일 차단: add-account, remove-account, init-host → 403

## 규칙 / Rules
- 계정 추가 시 Steampipe 재시작 필요
- Alias: 영문/숫자/공백/하이픈/언더스코어, 최대 64자
- Region: `^[a-z]{2}-[a-z]+-\d$` 형식
- Rate limit: 사용자당 분당 5회
