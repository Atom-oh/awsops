# AI 종합 진단 / AI Diagnosis

## 역할 / Role
15섹션 Bedrock Opus 분석 기반 종합 인프라 진단 페이지. 결과는 DOCX/PPTX/PDF로 내보내고 주간/격주/월간 자동 스케줄링 가능.
(Comprehensive 15-section infrastructure diagnosis using Bedrock Opus. Exports DOCX/PPTX/PDF with weekly/biweekly/monthly auto-scheduling.)

## 주요 파일 / Key Files
- `page.tsx` — 진단 실행/조회 UI (TOC 사이드바, 멀티 확장, 다운로드 버튼)
- `report/page.tsx` — 인쇄용 리포트 (흰 배경, A4 페이지 브레이크, 브라우저 Print-to-PDF)

## 연결된 라이브러리 / Backend
- `src/lib/report-generator.ts` — 데이터 수집 오케스트레이터 (Steampipe + CloudWatch + 외부 데이터소스)
- `src/lib/report-prompts.ts` — 15섹션 프롬프트 정의
- `src/lib/report-docx.ts` — DOCX (A4 + TOC + 마크다운 변환)
- `src/lib/report-pptx.ts` — PPTX (WADD 스타일)
- `src/lib/report-scheduler.ts` — cron 기반 자동 실행
- API: `api/report/route.ts` (POST 생성, GET 이력, S3 영구 저장)

## 규칙 / Rules
- 15개 섹션 순서 고정 — `report-prompts.ts`에서 정의
- 진단 결과는 S3에 저장 (`reportBucket` config) + 로컬 `reports/` 캐시 (gitignore)
- 대용량 응답은 스트리밍 렌더 (`ReportMarkdown` 컴포넌트)
- 다운로드 파일명: `awsops-diagnosis-{YYYYMMDD}-{accountAlias}.{ext}`
- PDF는 브라우저 print — 별도 PDF 라이브러리 추가 금지 (bundle size)
- 스케줄 설정은 admin 전용 (`adminEmails` 체크)

---

# AI Diagnosis (English)

## Role
Comprehensive 15-section infrastructure diagnosis powered by Bedrock Opus. Exports to DOCX/PPTX/PDF with weekly/biweekly/monthly scheduling.

## Rules
- 15-section order is fixed in `report-prompts.ts`
- Reports persist to S3 (`reportBucket` config) with a local cache under `reports/` (gitignored)
- Large outputs stream-render via `ReportMarkdown`
- Download naming: `awsops-diagnosis-{YYYYMMDD}-{accountAlias}.{ext}`
- PDFs use browser print — do not add new PDF libs (bundle size)
- Scheduling is admin-only (checked against `adminEmails`)
