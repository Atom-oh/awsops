# 외부 데이터소스 / External Datasources

## 역할 / Role
7종 외부 관측 플랫폼(Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog) 연결·쿼리·AI 기반 쿼리 생성 페이지.
(Connects, queries, and AI-generates queries for 7 external observability platforms.)

## 주요 파일 / Key Files
- `page.tsx` — 데이터소스 CRUD (등록/삭제/헬스체크/토큰 마스킹)
- `explore/page.tsx` — 쿼리 콘솔 (자연어 → 쿼리 번역, 결과 테이블/차트)

## 연결된 라이브러리 / Backend
- `src/lib/datasource-client.ts` — HTTP 클라이언트 (SSRF 방지 + allowlist)
- `src/lib/datasource-registry.ts` — 타입별 헬스 엔드포인트·쿼리 언어 레지스트리
- `src/lib/datasource-prompts.ts` — 타입별 자연어→쿼리 프롬프트
- API: `api/datasources/route.ts` (CRUD + execute + ai-generate)

## SSRF 방지 / SSRF Protection
- URL은 DNS 해석 후 private CIDR (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7) 차단
- 단, `accounts[].features.allowPrivateDatasource`가 true인 계정은 허용
- Redirect 따라가기 금지(max 0) — 리다이렉트를 통한 우회 방지
- 토큰/비밀번호는 DB 저장 시 암호화, API 응답에서 마스킹

## 규칙 / Rules
- 데이터소스 추가 시 `datasource-registry.ts`에 타입 메타데이터 우선 등록
- 쿼리 결과는 row 단위 스트리밍 — 대량 결과 메모리 폭발 방지
- AI 쿼리 생성: 자연어 입력 → `datasource-prompts.ts`의 해당 타입 프롬프트로 Bedrock 호출 → 생성된 쿼리 표시 후 사용자 확인 필요
- 헬스체크는 주기적(5분) 백그라운드 — 실패 시 UI 배지 `degraded`

---

# External Datasources (English)

## Role
Register, query, and AI-generate queries against 7 external observability platforms: Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog.

## SSRF Protections
- DNS-resolve URLs; block private CIDRs (10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7) unless `allowPrivateDatasource`
- No redirect following (max 0)
- Tokens/passwords encrypted at rest; masked in API responses

## Rules
- New platform: register metadata in `datasource-registry.ts` first
- Stream query results row-by-row; never buffer large result sets
- AI query generation always requires user confirmation before execution
- Health checks run every 5 minutes in background; surface `degraded` badges on failure
